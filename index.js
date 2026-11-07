require('dotenv').config();
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const ffmpegPath = require('ffmpeg-static');
const {
  Client,
  GatewayIntentBits,
  ActivityType,
  PresenceUpdateStatus,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  MessageFlags,
  Events,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  NoSubscriberBehavior,
} = require('@discordjs/voice');

const { DISCORD_TOKEN, GUILD_ID, YTDLP_PATH = 'yt-dlp', PORT = 3000 } = process.env;

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in environment variables.');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* YouTube & Network Flags                                             */
/* ------------------------------------------------------------------ */
const ytExtraArgs = [
  '--force-ipv4',
  '--no-check-certificates',
  '--extractor-args',
  'youtube:player_client=tv_embedded,web_creator,mweb;player_skip=configs',
];

if (process.env.YT_COOKIES_B64) {
  try {
    fs.writeFileSync('/tmp/yt-cookies.txt', Buffer.from(process.env.YT_COOKIES_B64, 'base64'));
    ytExtraArgs.push('--cookies', '/tmp/yt-cookies.txt');
    console.log('Using YouTube cookies from YT_COOKIES_B64');
  } catch (e) {
    console.error('Could not write cookies file:', e.message);
  }
}

if (process.env.YT_PROXY) {
  ytExtraArgs.push('--proxy', process.env.YT_PROXY);
}

/* ------------------------------------------------------------------ */
/* Client Initialization                                              */
/* ------------------------------------------------------------------ */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  presence: {
    status: PresenceUpdateStatus.DoNotDisturb,
    activities: [{ name: '/play', type: ActivityType.Listening }],
  },
});

/* ------------------------------------------------------------------ */
/* Slash Commands Definition                                          */
/* ------------------------------------------------------------------ */
const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song from YouTube, Spotify, or SoundCloud')
    .addStringOption((o) =>
      o.setName('query').setDescription('Song name, YouTube URL, or Spotify link').setRequired(true),
    ),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback, clear queue and leave'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the current song queue'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show current song information'),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the upcoming queue'),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set volume (1-100)')
    .addIntegerOption((o) =>
      o.setName('level').setDescription('Volume 1-100').setMinValue(1).setMaxValue(100).setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Set queue loop mode')
    .addStringOption((o) =>
      o
        .setName('mode')
        .setDescription('Loop mode')
        .setRequired(true)
        .addChoices(
          { name: 'Off', value: 'off' },
          { name: 'Current track', value: 'track' },
          { name: 'Whole queue', value: 'queue' },
        ),
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const appId = client.user.id;
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), { body: commands });
    console.log(`Registered ${commands.length} slash commands in guild ${GUILD_ID}`);
  } else {
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log(`Registered ${commands.length} global slash commands`);
  }
}

/* ------------------------------------------------------------------ */
/* Helpers & Resolvers                                                */
/* ------------------------------------------------------------------ */
const queues = new Map();
const isUrl = (s) => /^https?:\/\//i.test(s);

function fmtDuration(sec) {
  if (!sec) return 'LIVE';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}

function cleanTitle(title) {
  return title
    .replace(/[\(\[\{].*?[\)\]\}]/gi, '') // Remove (Slowed), [Official Video], etc.
    .replace(/[xX×]\s+[A-Za-z0-9_]+/g, '') // Remove featured artist additions
    .replace(/[^\w\s-]/gi, '') // Remove punctuation that breaks exact searches
    .replace(/\s+/g, ' ')
    .trim();
}

function isSpotifyUrl(u) {
  try {
    return /(^|\.)spotify\.com$/i.test(new URL(u).hostname);
  } catch {
    return false;
  }
}

function isYouTubeUrl(u) {
  try {
    return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(new URL(u).hostname);
  } catch {
    return false;
  }
}

async function spotifyMetaViaOembed(url) {
  const cleanUrl = url.split('?')[0];
  const res = await fetch(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(cleanUrl)}`,
    { signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) throw new Error(`Spotify oEmbed status ${res.status}`);
  const data = await res.json();
  return { title: data.title, thumbnail: data.thumbnail_url };
}

async function youtubeMetaViaOembed(url) {
  const u = new URL(url);
  let id = u.hostname === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v');
  const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/);
  if (!id && m) id = m[1];
  const watch = id ? `https://www.youtube.com/watch?v=${id}` : url;
  const res = await fetch(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`,
    { signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) throw new Error(`YouTube oEmbed status ${res.status}`);
  const data = await res.json();
  return {
    title: data.title,
    author: (data.author_name || '').replace(/ - Topic$/i, ''),
    thumbnail: data.thumbnail_url,
  };
}

function runYtDlpInfo(target) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      YTDLP_PATH,
      ['-j', '--no-playlist', '--no-warnings', '-q', ...ytExtraArgs, target],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) => reject(new Error(`yt-dlp spawn failure: ${e.message}`)));
    proc.on('close', (code) => {
      const line = out.split('\n').find((l) => l.trim().startsWith('{'));
      if (code !== 0 || !line) return reject(new Error(err.trim() || 'No audio sources found'));
      try {
        const j = JSON.parse(line);
        resolve({
          title: j.title,
          url: j.webpage_url || j.url,
          duration: j.duration,
          thumbnail: j.thumbnail,
          author: j.uploader || j.channel,
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function resolveTrack(query) {
  let targetQuery = query;
  let customThumbnail = null;

  // 1. Intercept Spotify URLs via oEmbed
  if (isUrl(query) && isSpotifyUrl(query)) {
    try {
      const meta = await spotifyMetaViaOembed(query);
      targetQuery = meta.title;
      customThumbnail = meta.thumbnail;
      console.log(`Resolved Spotify track: "${targetQuery}"`);
    } catch (e) {
      console.error(`Spotify oEmbed failed: ${e.message}`);
    }
  }

  // 2. Direct YouTube Links
  if (isUrl(targetQuery) && isYouTubeUrl(targetQuery)) {
    try {
      return await runYtDlpInfo(targetQuery);
    } catch (directErr) {
      console.error(`Direct YouTube lookup blocked: ${directErr.message}`);

      // Bypass datacenter bot challenge: fetch metadata via oEmbed, then search SoundCloud
      let oembed;
      try {
        oembed = await youtubeMetaViaOembed(targetQuery);
      } catch {
        throw new Error('Could not resolve YouTube metadata.');
      }

      const stripped = cleanTitle(oembed.title);
      const attempts = [
        oembed.title,
        stripped,
        `${stripped} ${oembed.author}`.trim(),
        oembed.author,
      ];

      for (const term of attempts) {
        if (!term) continue;
        try {
          console.log(`Trying SoundCloud match for: "${term}"`);
          const track = await runYtDlpInfo(`scsearch1:${term}`);
          track.title = oembed.title; // Keep original song title
          track.thumbnail = oembed.thumbnail || track.thumbnail;
          track.note = 'Resolved via SoundCloud audio mirror.';
          return track;
        } catch {}
      }

      throw new Error('YouTube is blocked on this datacenter IP and no fallback source was found.');
    }
  }

  // 3. Regular Queries & Searches (SoundCloud first to avoid IP bot blocks)
  const searchTargets = isUrl(targetQuery)
    ? [targetQuery]
    : [`scsearch1:${targetQuery}`, `ytsearch1:${targetQuery}`];

  let lastErr;
  for (const target of searchTargets) {
    try {
      const track = await runYtDlpInfo(target);
      if (customThumbnail) track.thumbnail = customThumbnail;
      return track;
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr;
}

function trackEmbed(title, track, extra) {
  const e = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .setDescription(`[${track.title}](${track.url})`)
    .addFields(
      { name: 'Duration', value: fmtDuration(track.duration), inline: true },
      { name: 'Requested by', value: track.requestedBy ?? 'Unknown', inline: true },
    );
  if (track.thumbnail) e.setThumbnail(track.thumbnail);
  if (extra) e.setFooter({ text: extra });
  return e;
}

/* ------------------------------------------------------------------ */
/* Voice Connection & Stable Transcoding Pipeline                     */
/* ------------------------------------------------------------------ */
async function createGuildQueue(interaction, voiceChannel) {
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    connection.destroy();
    throw new Error('Could not join voice channel.');
  }

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  connection.subscribe(player);

  const gq = {
    guildId: voiceChannel.guild.id,
    channelId: voiceChannel.id,
    textChannel: interaction.channel,
    connection,
    player,
    queue: [],
    current: null,
    resource: null,
    ytProc: null,
    ffmpegProc: null,
    volume: 50,
    loop: 'off',
    forceNext: false,
    leaveTimer: null,
  };

  player.on(AudioPlayerStatus.Idle, () => {
    killProc(gq);
    playNext(gq, true);
  });
  player.on('error', (err) => console.error('Audio Player error:', err.message));

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      destroyQueue(gq.guildId);
    }
  });

  queues.set(gq.guildId, gq);
  return gq;
}

function killProc(gq) {
  if (gq.ytProc) {
    gq.ytProc.kill('SIGKILL');
    gq.ytProc = null;
  }
  if (gq.ffmpegProc) {
    gq.ffmpegProc.kill('SIGKILL');
    gq.ffmpegProc = null;
  }
}

function destroyQueue(guildId) {
  const gq = queues.get(guildId);
  if (!gq) return;
  clearTimeout(gq.leaveTimer);
  gq.player.removeAllListeners();
  gq.player.stop(true);
  killProc(gq);
  if (gq.connection.state.status !== VoiceConnectionStatus.Destroyed) {
    gq.connection.destroy();
  }
  queues.delete(guildId);
}

function playNext(gq, announce) {
  clearTimeout(gq.leaveTimer);

  let next;
  if (gq.loop === 'track' && gq.current && !gq.forceNext) {
    next = gq.current;
  } else {
    if (gq.loop === 'queue' && gq.current) gq.queue.push(gq.current);
    next = gq.queue.shift();
  }
  gq.forceNext = false;

  if (!next) {
    gq.current = null;
    gq.leaveTimer = setTimeout(() => {
      gq.textChannel?.send('Queue finished. Leaving the voice channel.').catch(() => {});
      destroyQueue(gq.guildId);
    }, 120_000);
    return;
  }

  gq.current = next;

  // Spawn yt-dlp to output raw audio
  const ytProc = spawn(
    YTDLP_PATH,
    [
      '-f', 'bestaudio/best',
      '-o', '-',
      '-q',
      '--no-warnings',
      '--no-playlist',
      ...ytExtraArgs,
      next.url,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  gq.ytProc = ytProc;

  // Transcode cleanly to 48kHz Stereo 16-bit PCM for Discord
  const ffmpegBin = ffmpegPath || 'ffmpeg';
  const ffmpegProc = spawn(
    ffmpegBin,
    [
      '-analyzeduration', '0',
      '-loglevel', '0',
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      'pipe:1',
    ],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  );
  gq.ffmpegProc = ffmpegProc;

  ytProc.stdout.pipe(ffmpegProc.stdin);

  ytProc.on('error', (e) => console.error('yt-dlp stream error:', e.message));
  ffmpegProc.on('error', (e) => console.error('FFmpeg transcode error:', e.message));

  const resource = createAudioResource(ffmpegProc.stdout, {
    inputType: StreamType.Raw,
    inlineVolume: true,
  });
  resource.volume.setVolume(gq.volume / 100);
  gq.resource = resource;
  gq.player.play(resource);

  if (announce && gq.loop !== 'track') {
    gq.textChannel?.send({ embeds: [trackEmbed('Now playing', next)] }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Slash Command Handlers                                             */
/* ------------------------------------------------------------------ */
const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

async function handlePlay(interaction) {
  const voiceChannel = interaction.member.voice?.channel;
  if (!voiceChannel) return interaction.reply(ephemeral('Join a voice channel first.'));

  const perms = voiceChannel.permissionsFor(interaction.guild.members.me);
  if (!perms?.has(['ViewChannel', 'Connect', 'Speak'])) {
    return interaction.reply(ephemeral('I need permissions to View, Connect, and Speak in that channel.'));
  }

  let gq = queues.get(interaction.guildId);
  if (gq && gq.channelId !== voiceChannel.id) {
    return interaction.reply(ephemeral("I'm already playing in another voice channel."));
  }

  await interaction.deferReply();

  let track;
  try {
    track = await resolveTrack(interaction.options.getString('query', true));
  } catch (err) {
    console.error(err.message);
    return interaction.editReply(err.message || 'Could not find any playable audio.');
  }
  track.requestedBy = interaction.member.displayName;

  try {
    gq = queues.get(interaction.guildId) ?? (await createGuildQueue(interaction, voiceChannel));
  } catch (err) {
    return interaction.editReply(err.message);
  }

  gq.textChannel = interaction.channel;
  gq.queue.push(track);

  if (!gq.current) {
    playNext(gq, false);
    return interaction.editReply({ embeds: [trackEmbed('Now playing', track, track.note)] });
  }

  return interaction.editReply({
    embeds: [
      trackEmbed('Added to queue', track, `Position ${gq.queue.length}${track.note ? ' | ' + track.note : ''}`),
    ],
  });
}

const handlers = {
  play: handlePlay,
  async skip(i, gq) {
    gq.forceNext = true;
    gq.player.stop(true);
    return i.reply('Skipped to the next track.');
  },
  async pause(i, gq) {
    return i.reply(gq.player.pause() ? 'Paused playback.' : ephemeral('Nothing is playing to pause.'));
  },
  async resume(i, gq) {
    return i.reply(gq.player.unpause() ? 'Resumed playback.' : ephemeral('Playback is not paused.'));
  },
  async stop(i, gq) {
    destroyQueue(gq.guildId);
    return i.reply('Stopped playback, cleared the queue, and disconnected.');
  },
  async queue(i, gq) {
    if (!gq.current && !gq.queue.length) return i.reply(ephemeral('The queue is empty.'));
    const lines = gq.queue
      .slice(0, 10)
      .map((t, n) => `**${n + 1}.** [${t.title}](${t.url}) \`${fmtDuration(t.duration)}\``);
    const more = gq.queue.length > 10 ? `\n...and ${gq.queue.length - 10} more` : '';
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('Queue')
      .setDescription(
        (gq.current ? `**Now playing:** [${gq.current.title}](${gq.current.url})\n\n` : '') +
          (lines.length ? lines.join('\n') + more : 'No tracks queued up next.'),
      )
      .setFooter({ text: `Loop: ${gq.loop} | Volume: ${gq.volume}%` });
    return i.reply({ embeds: [embed] });
  },
  async nowplaying(i, gq) {
    if (!gq.current) return i.reply(ephemeral('Nothing is currently playing.'));
    const elapsed = Math.floor((gq.resource?.playbackDuration ?? 0) / 1000);
    return i.reply({
      embeds: [
        trackEmbed(
          'Now playing',
          gq.current,
          `${fmtDuration(elapsed)} / ${fmtDuration(gq.current.duration)}`,
        ),
      ],
    });
  },
  async shuffle(i, gq) {
    if (gq.queue.length < 2) return i.reply(ephemeral('At least 2 songs are needed to shuffle.'));
    for (let n = gq.queue.length - 1; n > 0; n--) {
      const k = Math.floor(Math.random() * (n + 1));
      [gq.queue[n], gq.queue[k]] = [gq.queue[k], gq.queue[n]];
    }
    return i.reply('Queue shuffled.');
  },
  async volume(i, gq) {
    gq.volume = i.options.getInteger('level', true);
    gq.resource?.volume?.setVolume(gq.volume / 100);
    return i.reply(`Volume adjusted to **${gq.volume}%**.`);
  },
  async loop(i, gq) {
    gq.loop = i.options.getString('mode', true);
    return i.reply(`Loop mode set to **${gq.loop}**.`);
  },
};

/* ------------------------------------------------------------------ */
/* Events                                                             */
/* ------------------------------------------------------------------ */
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setPresence({
    status: PresenceUpdateStatus.DoNotDisturb,
    activities: [{ name: '/play', type: ActivityType.Listening }],
  });
  try {
    await registerCommands();
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;

  const handler = handlers[interaction.commandName];
  if (!handler) return;

  try {
    if (interaction.commandName === 'play') return await handler(interaction);

    const gq = queues.get(interaction.guildId);
    if (!gq) return interaction.reply(ephemeral('Nothing is currently playing.'));
    if (interaction.member.voice?.channelId !== gq.channelId) {
      return interaction.reply(ephemeral('You must be in the same voice channel to use that.'));
    }
    return await handler(interaction, gq);
  } catch (err) {
    console.error(err);
    const msg = ephemeral('An unexpected error occurred executing this command.');
    if (interaction.deferred || interaction.replied) interaction.followUp(msg).catch(() => {});
    else interaction.reply(msg).catch(() => {});
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const gq = queues.get(oldState.guild.id);
  if (!gq) return;
  if (oldState.id === client.user.id && !newState.channelId) return destroyQueue(gq.guildId);

  const channel = oldState.guild.channels.cache.get(gq.channelId);
  if (channel && channel.members.filter((m) => !m.user.bot).size === 0) {
    gq.textChannel?.send('All users left the voice channel. Disconnecting.').catch(() => {});
    destroyQueue(gq.guildId);
  }
});

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

/* ------------------------------------------------------------------ */
/* Render Keep-Alive Port Listener                                    */
/* ------------------------------------------------------------------ */
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot service is running.\n');
  })
  .listen(PORT, () => {
    console.log(`Keep-alive web server active on port ${PORT}`);
  });

client.login(DISCORD_TOKEN);
