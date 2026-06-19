/**
 * Startup notification + agent pre-warm.
 *
 * Runs once at the end of `main()`, after channel adapters are connected and
 * delivery is wired. Two-stage owner notification:
 *
 *   Ping #1 (immediate, host-side): the host is online and listening. Sent
 *     straight through the channel adapter — the agent container isn't up yet.
 *   Pre-warm: inject a warm-up message into each owner-DM session and spawn its
 *     container. This pays the container/SDK cold start in the background so the
 *     owner's first real request responds promptly.
 *   Ping #2 (the agent's own reply to the warm-up): proves the agent is warm,
 *     routed to the DM via the session's default reply destination.
 *
 * A background watcher on the session heartbeat is the safety net: if a
 * container never comes up within the timeout, the host sends a fallback notice
 * (so a stuck warm-up can't leave the owner silently waiting on a ping #2 that
 * never arrives).
 *
 * Best-effort throughout: failures are logged, never thrown — a notification
 * problem must not take down host startup.
 */
import fs from 'fs';

import { getChannelAdapterExact } from './channels/channel-registry.js';
import { TIMEZONE } from './config.js';
import { wakeContainer } from './container-runner.js';
import { getSession } from './db/sessions.js';
import { getMessagingGroupAgents } from './db/messaging-groups.js';
import { log } from './log.js';
import { getOwners } from './modules/permissions/db/user-roles.js';
import { ensureUserDm } from './modules/permissions/user-dm.js';
import { heartbeatPath, resolveSession, writeSessionMessage } from './session-manager.js';
import type { MessagingGroup, Session } from './types.js';

/** How long to wait for a warm-up container to come up before the fallback. */
const WARM_TIMEOUT_MS = 5 * 60 * 1000;
const WARM_POLL_MS = 3000;

const WARMUP_PROMPT = [
  'SYSTEM WARM-UP PING (automated — sent once when the host starts up).',
  'Reply with ONE short, friendly sentence confirming you are online, warmed up, and ready for requests.',
  'Do NOT take any other action: do not read files, do not start or prepare any report, do not call any tool beyond sending your reply.',
].join(' ');

async function deliverToOwnerDm(mg: MessagingGroup, text: string): Promise<boolean> {
  const adapter = getChannelAdapterExact(mg.instance ?? mg.channel_type);
  if (!adapter) return false;
  try {
    await adapter.deliver(mg.platform_id, null, { kind: 'chat', content: { text } });
    return true;
  } catch (err) {
    log.warn('Startup notification delivery failed', { channel: mg.channel_type, err });
    return false;
  }
}

/** Poll the session heartbeat; if it never freshens, send a fallback notice. */
function watchWarmup(session: Session, mg: MessagingGroup): void {
  const hbPath = heartbeatPath(session.agent_group_id, session.id);
  const since = Date.now();
  const deadline = since + WARM_TIMEOUT_MS;

  const tick = (): void => {
    let warm = false;
    try {
      warm = fs.statSync(hbPath).mtimeMs >= since;
    } catch {
      warm = false; // heartbeat file not present yet
    }
    if (warm) {
      log.info('Pre-warm confirmed — agent container is live', { sessionId: session.id });
      return; // agent's own reply serves as ping #2; nothing else to do
    }
    if (Date.now() >= deadline) {
      log.warn('Pre-warm not confirmed before timeout — sending fallback notice', { sessionId: session.id });
      void deliverToOwnerDm(
        mg,
        '⚠️ The agent is taking longer than usual to warm up. It should be ready shortly — try sending your request in a minute.',
      );
      return;
    }
    setTimeout(tick, WARM_POLL_MS);
  };
  setTimeout(tick, WARM_POLL_MS);
}

export async function notifyOwnersOnline(): Promise<void> {
  try {
    const owners = getOwners();
    if (owners.length === 0) return;

    const stamp = new Date().toLocaleString('en-US', { timeZone: TIMEZONE });
    const seenSessions = new Set<string>();
    let pinged = 0;
    let warmed = 0;

    for (const owner of owners) {
      const mg = await ensureUserDm(owner.user_id);
      if (!mg) continue;

      // Ping #1 — host is up. Sent directly; the agent isn't running yet.
      const ok = await deliverToOwnerDm(
        mg,
        `✅ NanoClaw is online — ${stamp}.\nWarming up the agent now; I'll message you here as soon as it's ready for requests.`,
      );
      if (ok) pinged++;

      // Pre-warm every agent wired to this DM: inject a warm-up message
      // (its reply becomes ping #2) and spawn the container in the background.
      for (const wiring of getMessagingGroupAgents(mg.id)) {
        const mode = wiring.session_mode as 'shared' | 'per-thread' | 'agent-shared';
        const { session } = resolveSession(wiring.agent_group_id, mg.id, mg.platform_id, mode);
        if (seenSessions.has(session.id)) continue;
        seenSessions.add(session.id);

        writeSessionMessage(session.agent_group_id, session.id, {
          id: `warmup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          // Stamp the DM's routing so the agent's reply (ping #2) lands in the DM.
          channelType: mg.channel_type,
          platformId: mg.platform_id,
          threadId: session.thread_id,
          content: JSON.stringify({ text: WARMUP_PROMPT, sender: 'system', senderId: 'system' }),
          trigger: 1,
        });

        const fresh = getSession(session.id) ?? session;
        void wakeContainer(fresh);
        watchWarmup(fresh, mg);
        warmed++;
      }
    }

    if (pinged > 0 || warmed > 0) {
      log.info('Startup notification sent + pre-warm dispatched', { owners: pinged, sessions: warmed });
    }
  } catch (err) {
    log.error('Startup notification failed', { err });
  }
}
