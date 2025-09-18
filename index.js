/**
 * AoM Retold "Game Night" Bot – simplified:
 *  - Single PvP option (plus Vs Bots, Co-op Campaign)
 *  - No max players
 *  - Friendly time input (natural-ish): "today 7pm", "tomorrow 8:30pm",
 *    "in 45m", "in 2h", or "YYYY-MM-DD HH:MM"
 *  - If 'when' omitted, auto-posts a Time Poll with quick choices.
 */

import "dotenv/config";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  PermissionsBitField,
} from "discord.js";

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error("Missing DISCORD_TOKEN or CLIENT_ID in .env");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// ---------------- In-memory state ----------------
/**
 * lobbies keyed by messageId:
 * {
 *   ownerId: string,
 *   type: string,                  // 'pvp' | 'pve-bots' | 'coop-campaign'
 *   startUnix?: number,            // set by parser or time poll
 *   members: Set<string>,
 *   maps: string[],
 *   votes: Map<number, number>,
 *   voterChoice: Map<string, number>
 * }
 */
const lobbies = new Map();

const DEFAULT_MAPS = [
  "Mediterranean",
  "Oasis",
  "Alfheim",
  "Ghost Lake",
  "Savannah",
  "Marsh",
  "Anatolia",
  "Islands",
];

const TYPE_CHOICES = [
  { name: "PvP", value: "pvp" },
  { name: "Skirmish vs Bots", value: "pve-bots" },
  { name: "Co-op Campaign", value: "coop-campaign" },
];

const ts = (unix) => `<t:${unix}:F> (<t:${unix}:R>)`;

// ---------------- Slash commands ----------------
const commands = [
  new SlashCommandBuilder()
    .setName("game")
    .setDescription("Create/list/cancel AoM games.")
    .addSubcommand((sc) =>
      sc
        .setName("create")
        .setDescription("Create a game post with map voting.")
        .addStringOption((o) =>
          o
            .setName("type")
            .setDescription("Game type")
            .setRequired(true)
            .addChoices(...TYPE_CHOICES)
        )
        .addStringOption((o) =>
          o
            .setName("when")
            .setDescription(
              'e.g., "today 7pm", "in 45m", "2025-09-18 19:30" (optional)'
            )
        )
        .addStringOption((o) =>
          o
            .setName("maps")
            .setDescription(
              "Comma-separated maps (optional; defaults used if blank)"
            )
        )
        .addRoleOption((o) =>
          o.setName("ping_role").setDescription("Role to ping (optional)")
        )
    )
    .addSubcommand((sc) =>
      sc.setName("list").setDescription("List active game posts.")
    )
    .addSubcommand((sc) =>
      sc
        .setName("cancel")
        .setDescription("Cancel a game post you created.")
        .addStringOption((o) =>
          o
            .setName("message")
            .setDescription("Message URL or message ID of the game post")
            .setRequired(true)
        )
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });
    console.log("✓ Registered guild commands.");
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("✓ Registered global commands.");
  }
}

// ---------------- Embeds & Components ----------------
function gameTypePretty(typeVal) {
  const found = TYPE_CHOICES.find((t) => t.value === typeVal);
  return found ? found.name : typeVal;
}

function buildEmbed(state) {
  const members = [...state.members].map((id) => `<@${id}>`).join("\n") || "—";
  const mapFields = state.maps.map((m, i) => {
    const count = state.votes.get(i) || 0;
    return { name: m, value: `Votes: **${count}**`, inline: true };
  });

  const leaderIdx = topMapIndex(state);
  const leaderText =
    typeof leaderIdx === "number"
      ? `Leading: **${state.maps[leaderIdx]}**`
      : "No votes yet";

  const timeLine = state.startUnix
    ? `Start: ${ts(state.startUnix)}`
    : "Start: *(choose a time below)*";

  return new EmbedBuilder()
    .setTitle(`AoM Game • ${gameTypePretty(state.type)}`)
    .setDescription(
      `${timeLine}\n` +
        `Map Voting below (1 vote per player; you can change it).`
    )
    .addFields(
      { name: "Players", value: `${state.members.size}`, inline: true },
      { name: "Current Map", value: leaderText, inline: true },
      { name: "Joined", value: members }
    )
    .addFields(mapFields.length ? mapFields : [])
    .setColor(0x00a3ff);
}

function buildButtonsRow(ownerId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("aom_join")
      .setLabel("Join")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("aom_leave")
      .setLabel("Leave")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`aom_cancel_${ownerId}`)
      .setLabel("Cancel (Owner)")
      .setStyle(ButtonStyle.Danger)
  );
}

function buildMapSelect(maps) {
  const options = maps.map((m, i) => ({ label: m, value: String(i) }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("aom_map_select")
      .setPlaceholder("Vote for a map")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options)
  );
}

function buildTimePollRow(now = new Date()) {
  // Quick options: +30m, +1h, Tonight 7pm, Tomorrow 7pm
  const opt30 = Math.floor(
    new Date(now.getTime() + 30 * 60 * 1000).getTime() / 1000
  );
  const opt60 = Math.floor(
    new Date(now.getTime() + 60 * 60 * 1000).getTime() / 1000
  );

  const tonight7 = (() => {
    const d = new Date(now);
    d.setHours(19, 0, 0, 0);
    if (d.getTime() < now.getTime()) d.setDate(d.getDate() + 1); // if past 7pm, push to next day
    return Math.floor(d.getTime() / 1000);
  })();

  const tomorrow7 = (() => {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(19, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  })();

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`aom_time_${opt30}`)
      .setLabel("+30m")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`aom_time_${opt60}`)
      .setLabel("+1h")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`aom_time_${tonight7}`)
      .setLabel("Tonight 7pm")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`aom_time_${tomorrow7}`)
      .setLabel("Tomorrow 7pm")
      .setStyle(ButtonStyle.Secondary)
  );
}

function topMapIndex(state) {
  let bestIdx = null;
  let best = -1;
  for (let i = 0; i < state.maps.length; i++) {
    const c = state.votes.get(i) || 0;
    if (c > best) {
      best = c;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// ---------------- Time parsing ----------------
function parseWhen(input, now = new Date()) {
  if (!input) return null;
  const s = input.trim().toLowerCase();

  // in Xm / in Xh
  let m = s.match(/^in\s+(\d+)\s*m(in(ute)?s?)?$/i);
  if (m) {
    const minutes = parseInt(m[1], 10);
    return new Date(now.getTime() + minutes * 60 * 1000);
  }
  m = s.match(/^in\s+(\d+)\s*h(ours?)?$/i);
  if (m) {
    const hours = parseInt(m[1], 10);
    return new Date(now.getTime() + hours * 60 * 60 * 1000);
  }

  // today HH:MM(am/pm)
  m = s.match(/^today\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (m) return hhmmpToDate(now, m);
  // tomorrow HH:MM(am/pm)
  m = s.match(/^tomorrow\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (m) return hhmmpToDate(new Date(now.getTime() + 24 * 60 * 60 * 1000), m);

  // YYYY-MM-DD HH:MM
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const [_, Y, Mo, D, H, Mi] = m;
    const d = new Date(
      Number(Y),
      Number(Mo) - 1,
      Number(D),
      Number(H),
      Number(Mi),
      0,
      0
    );
    return d;
  }

  // HH:MM (assume today)
  m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (m) return hhmmpToDate(now, m);

  // Hpm / Ham (like "7pm")
  m = s.match(/^(\d{1,2})\s*(am|pm)$/i);
  if (m) return hhmmpToDate(now, [null, m[1], "00", m[2]]);

  return null; // not parsed
}

function hhmmpToDate(baseDate, match) {
  let hour = Number(match[1]);
  const min = match[2] ? Number(match[2]) : 0;
  const ampm = match[3]?.toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;

  const d = new Date(baseDate);
  d.setHours(hour, min, 0, 0);
  return d;
}

// ---------------- Client handlers ----------------
client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== "game") return;

      const sub = interaction.options.getSubcommand();

      if (sub === "create") {
        const type = interaction.options.getString("type", true);
        const whenStr = interaction.options.getString("when");
        const mapsRaw = interaction.options.getString("maps");
        const role = interaction.options.getRole("ping_role");

        // Build map list
        let maps = mapsRaw
          ? mapsRaw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : DEFAULT_MAPS;
        // Keep ≤25, preserve order
        maps = maps.slice(0, 25);

        const state = {
          ownerId: interaction.user.id,
          type,
          members: new Set([interaction.user.id]),
          maps,
          votes: new Map(),
          voterChoice: new Map(),
        };

        // Parse time if provided
        const parsed = parseWhen(whenStr || "");
        if (parsed) {
          state.startUnix = Math.floor(parsed.getTime() / 1000);
        }

        const content = role ? `<@&${role.id}>` : "";
        const components = [
          buildButtonsRow(state.ownerId),
          buildMapSelect(state.maps),
        ];
        if (!state.startUnix) components.unshift(buildTimePollRow(new Date()));

        const msg = await interaction.reply({
          content,
          embeds: [buildEmbed(state)],
          components,
          fetchReply: true,
        });

        lobbies.set(msg.id, state);
        return;
      }

      if (sub === "list") {
        const entries = [];
        for (const [messageId, s] of lobbies.entries()) {
          const timeText = s.startUnix ? ts(s.startUnix) : "*time not set*";
          entries.push(
            `• **${gameTypePretty(s.type)}** — ${timeText} — Players ${
              s.members.size
            } — id: \`${messageId}\``
          );
        }
        await interaction.reply({
          content: entries.length ? entries.join("\n") : "No active games.",
          ephemeral: true,
        });
        return;
      }

      if (sub === "cancel") {
        const raw = interaction.options.getString("message", true).trim();
        const messageId = extractMessageId(raw);
        if (!messageId) {
          await interaction.reply({
            content: "Could not parse message ID/URL.",
            ephemeral: true,
          });
          return;
        }
        const state = lobbies.get(messageId);
        if (!state) {
          await interaction.reply({
            content: "No active game found for that message.",
            ephemeral: true,
          });
          return;
        }
        if (
          state.ownerId !== interaction.user.id &&
          !interaction.member.permissions?.has(
            PermissionsBitField.Flags.Administrator
          )
        ) {
          await interaction.reply({
            content: "Only the creator or an admin can cancel.",
            ephemeral: true,
          });
          return;
        }
        lobbies.delete(messageId);
        // Try editing the original message (best-effort)
        try {
          const channel =
            interaction.channel ??
            (await interaction.guild.channels.fetch(interaction.channelId));
          const msg = await channel.messages.fetch(messageId);
          await msg.edit({
            embeds: [
              new EmbedBuilder().setTitle("Game Canceled").setColor(0xb71c1c),
            ],
            components: [],
          });
        } catch {
          /* ignore */
        }
        await interaction.reply({ content: "Canceled.", ephemeral: true });
        return;
      }
    }

    // Buttons & selects
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      const messageId = interaction.message.id;
      const state = lobbies.get(messageId);
      if (!state) {
        await interaction.reply({
          content: "This game is no longer active.",
          ephemeral: true,
        });
        return;
      }

      // Time poll choices
      if (
        interaction.isButton() &&
        interaction.customId.startsWith("aom_time_")
      ) {
        const unix = Number(interaction.customId.split("aom_time_")[1]);
        if (!Number.isFinite(unix)) {
          await interaction.reply({
            content: "Invalid time option.",
            ephemeral: true,
          });
          return;
        }
        // Only owner or admins set time?
        if (
          interaction.user.id !== state.ownerId &&
          !interaction.member.permissions?.has(
            PermissionsBitField.Flags.Administrator
          )
        ) {
          await interaction.reply({
            content: "Only the creator or an admin can set the time.",
            ephemeral: true,
          });
          return;
        }
        state.startUnix = unix;
        await interaction.update({
          embeds: [buildEmbed(state)],
          components: [
            buildButtonsRow(state.ownerId),
            buildMapSelect(state.maps),
          ], // remove time poll row
        });
        return;
      }

      // Cancel (owner)
      if (
        interaction.isButton() &&
        interaction.customId.startsWith("aom_cancel_")
      ) {
        const ownerId = interaction.customId.split("aom_cancel_")[1];
        if (
          interaction.user.id !== ownerId &&
          !interaction.member.permissions?.has(
            PermissionsBitField.Flags.Administrator
          )
        ) {
          await interaction.reply({
            content: "Only the creator or an admin can cancel.",
            ephemeral: true,
          });
          return;
        }
        lobbies.delete(messageId);
        await interaction.update({
          embeds: [
            new EmbedBuilder().setTitle("Game Canceled").setColor(0xb71c1c),
          ],
          components: [],
        });
        return;
      }

      // Join / Leave
      if (interaction.isButton() && interaction.customId === "aom_join") {
        if (state.members.has(interaction.user.id)) {
          await interaction.reply({
            content: "You already joined.",
            ephemeral: true,
          });
          return;
        }
        state.members.add(interaction.user.id);
        await interaction.update({
          embeds: [buildEmbed(state)],
          components: buildComponentsForState(state),
        });
        return;
      }

      if (interaction.isButton() && interaction.customId === "aom_leave") {
        if (!state.members.has(interaction.user.id)) {
          await interaction.reply({
            content: "You are not in this lobby.",
            ephemeral: true,
          });
          return;
        }
        state.members.delete(interaction.user.id);
        // Remove their map vote too (optional)
        const prev = state.voterChoice.get(interaction.user.id);
        if (prev !== undefined) {
          state.voterChoice.delete(interaction.user.id);
          state.votes.set(prev, Math.max((state.votes.get(prev) || 1) - 1, 0));
        }
        await interaction.update({
          embeds: [buildEmbed(state)],
          components: buildComponentsForState(state),
        });
        return;
      }

      // Map vote
      if (
        interaction.isStringSelectMenu() &&
        interaction.customId === "aom_map_select"
      ) {
        const idx = Number(interaction.values[0]);
        if (Number.isNaN(idx) || !state.maps[idx]) {
          await interaction.reply({
            content: "Invalid map selection.",
            ephemeral: true,
          });
          return;
        }
        const prev = state.voterChoice.get(interaction.user.id);
        if (prev !== undefined) {
          state.votes.set(prev, Math.max((state.votes.get(prev) || 1) - 1, 0));
        }
        state.voterChoice.set(interaction.user.id, idx);
        state.votes.set(idx, (state.votes.get(idx) || 0) + 1);

        await interaction.update({
          embeds: [buildEmbed(state)],
          components: buildComponentsForState(state),
        });
        return;
      }
    }
  } catch (err) {
    console.error(err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: "Something went wrong.",
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: "Something went wrong.",
          ephemeral: true,
        });
      }
    } catch {}
  }
});

// Components helper: include time poll if time not set
function buildComponentsForState(state) {
  const rows = [];
  if (!state.startUnix) rows.push(buildTimePollRow(new Date()));
  rows.push(buildButtonsRow(state.ownerId), buildMapSelect(state.maps));
  return rows;
}

// ---------------- Utils ----------------
function extractMessageId(raw) {
  const m = raw.match(/\/channels\/\d+\/\d+\/(\d+)/);
  if (m) return m[1];
  if (/^\d{17,20}$/.test(raw)) return raw;
  return null;
}

// ---------------- Entry ----------------
if (process.argv[2] === "register") {
  await registerCommands();
  process.exit(0);
} else {
  client.login(DISCORD_TOKEN);
}
