import type { FastifyInstance } from "fastify";
import { AccessToken } from "livekit-server-sdk";
import { prisma } from "../plugins/db.js";
import { canAccessChannel } from "../util/permissions.js";

export async function voiceRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  // Mints a LiveKit access token scoped to one voice channel (the LiveKit
  // "room" is just the channel id). Any authenticated user on this instance
  // may join, same as message history — unless the channel is
  // role-restricted, same gate as the gateway's own VOICE_JOIN. Without this
  // check a restricted voice channel would only be hidden from the sidebar,
  // not actually unjoinable, since LiveKit itself has no idea about roles.
  app.post("/channels/:channelId/voice-token", async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    const { sub: userId, username } = req.user as { sub: string; username: string };

    const channel = await prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) return reply.status(404).send({ error: "channel not found" });
    if (channel.type !== "VOICE") return reply.status(400).send({ error: "not a voice channel" });
    if (!(await canAccessChannel(userId, channel))) return reply.status(403).send({ error: "channel not found" });

    const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
      identity: userId,
      name: username,
    });
    at.addGrant({ roomJoin: true, room: channelId, canPublish: true, canSubscribe: true });

    return { token: await at.toJwt(), url: process.env.LIVEKIT_URL };
  });
}
