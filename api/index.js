const { Telegraf, Markup } = require('telegraf');
const { MongoClient, ObjectId } = require('mongodb');
const sharp = require('sharp');

// --- Environment Variables (No Hardcoded Secrets) ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
const CONTACT_ADMIN_URL = process.env.CONTACT_ADMIN_URL || 'https://t.me/LankaAdmin_bot';

const bot = new Telegraf(BOT_TOKEN);

// --- Register Commands Strictly for Admin ---
let commandsRegistered = false;
async function setupAdminCommands() {
  if (commandsRegistered || !ADMIN_ID) return;
  try {
    await bot.telegram.setMyCommands(
      [
        { command: 'start', description: 'Check Bot Status' },
        { command: 'admin', description: 'Open Control Panel' },
        { command: 'cancel', description: 'Cancel Current Action' }
      ],
      { scope: { type: 'chat', chat_id: ADMIN_ID } }
    );
    commandsRegistered = true;
  } catch (err) {}
}

// --- MongoDB Global Cache ---
let cachedDb = null;
let clientPromise = null;

async function getDb() {
  if (cachedDb) return cachedDb;
  if (!clientPromise) {
    const client = new MongoClient(MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000
    });
    clientPromise = client.connect();
  }
  const client = await clientPromise;
  cachedDb = client.db('vip_promo_db');
  return cachedDb;
}

// --- Default Config Helper ---
async function getConfig(db) {
  let cfg = await db.collection('settings').findOne({ _id: 'main_config' });
  if (!cfg) {
    cfg = {
      _id: 'main_config',
      is_active: true,
      daily_limit: 3,
      schedule_times: ['09:00', '14:30', '20:00'],
      caption_text: '🔥 NEW UPDATE ADDED TO VIP!\n\n✅ Full Album & Videos available now.\n💰 VIP Access: Rs. 500/= Only',
      caption_entities: [],
      blur_frame: true,
      watermark_enabled: true,
      watermark_text: 'Hot Lanka',
      pending_batch_count: 0,
      last_posted_slot: null,
      is_posting_locked: false,
      admin_state: null
    };
    await db.collection('settings').insertOne(cfg);
  }
  return cfg;
}

// --- Image Processing: Glassmorphism Blur Frame + Subtle SVG Watermark ---
async function processImageWithEffects(fileId, cfg) {
  const fileLink = await bot.telegram.getFileLink(fileId);
  const response = await fetch(fileLink.href);
  if (!response.ok) throw new Error('FILE_UNAVAILABLE');
  const inputBuffer = Buffer.from(await response.arrayBuffer());

  if (!cfg.blur_frame && !cfg.watermark_enabled) {
    return inputBuffer;
  }

  const baseImg = sharp(inputBuffer);
  const metadata = await baseImg.metadata();
  const origW = metadata.width || 720;
  const origH = metadata.height || 1280;

  let foregroundBuffer = inputBuffer;

  // 1. Apply Subtle Centered Watermark on Foreground Screenshot
  if (cfg.watermark_enabled) {
    const wmText = (cfg.watermark_text || 'Hot Lanka')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const fontSize = Math.max(24, Math.round(origW * 0.13));

    const watermarkSvg = Buffer.from(`
      <svg width="${origW}" height="${origH}">
        <style>
          .wm {
            fill: rgba(255, 255, 255, 0.28);
            font-size: ${fontSize}px;
            font-weight: 800;
            font-family: sans-serif;
            letter-spacing: 2px;
          }
        </style>
        <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" class="wm">${wmText}</text>
      </svg>
    `);

    foregroundBuffer = await sharp(inputBuffer)
      .composite([{ input: watermarkSvg, gravity: 'center' }])
      .toBuffer();
  }

  if (!cfg.blur_frame) {
    return foregroundBuffer;
  }

  // 2. Apply Dynamic Glassmorphism Blurred Frame (Handles 9:16 and Extra Tall Images)
  const padX = Math.round(origW * 0.11);
  const padY = Math.round(origH * 0.08);
  const canvasW = origW + padX * 2;
  const canvasH = origH + padY * 2;
  const cornerRadius = Math.max(16, Math.round(origW * 0.035));

  // Blurred darkened background
  const blurredBg = await sharp(inputBuffer)
    .resize(canvasW, canvasH, { fit: 'cover' })
    .blur(28)
    .modulate({ brightness: 0.65 })
    .toBuffer();

  // Rounded mask for crisp foreground card
  const roundedMask = Buffer.from(`
    <svg width="${origW}" height="${origH}">
      <rect x="0" y="0" width="${origW}" height="${origH}" rx="${cornerRadius}" ry="${cornerRadius}" fill="#ffffff"/>
    </svg>
  `);

  const roundedForeground = await sharp(foregroundBuffer)
    .resize(origW, origH)
    .composite([{ input: roundedMask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  // Subtle glass border outline
  const glassBorder = Buffer.from(`
    <svg width="${canvasW}" height="${canvasH}">
      <rect x="${padX}" y="${padY}" width="${origW}" height="${origH}" rx="${cornerRadius}" ry="${cornerRadius}"
            fill="none" stroke="rgba(255, 255, 255, 0.25)" stroke-width="3"/>
    </svg>
  `);

  return await sharp(blurredBg)
    .composite([
      { input: roundedForeground, left: padX, top: padY },
      { input: glassBorder, left: 0, top: 0 }
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}

// --- Publish Single Next Valid Item from Queue ---
async function publishNextQueueItem(db, cfg, notifyAdmin = true) {
  const fixedButton = Markup.inlineKeyboard([
    [Markup.button.url('Contact Admin', CONTACT_ADMIN_URL)]
  ]);

  while (true) {
    const nextItem = await db.collection('queue')
      .find({})
      .sort({ order: 1, message_id: 1, _id: 1 })
      .limit(1)
      .next();

    if (!nextItem) {
      return { status: 'empty' };
    }

    try {
      const finalImageBuffer = await processImageWithEffects(nextItem.file_id, cfg);

      const postOptions = {
        caption: cfg.caption_text || '',
        caption_entities: cfg.caption_entities && cfg.caption_entities.length > 0 ? cfg.caption_entities : undefined,
        ...fixedButton
      };

      await bot.telegram.sendPhoto(TARGET_CHANNEL_ID, { source: finalImageBuffer }, postOptions);
      await db.collection('queue').deleteOne({ _id: nextItem._id });

      if (notifyAdmin) {
        await bot.telegram.sendMessage(ADMIN_ID, '🚀 Posted to channel!').catch(() => {});
      }

      return { status: 'posted' };
    } catch (err) {
      // Remove invalid/deleted image and skip to next automatically
      await db.collection('queue').deleteOne({ _id: nextItem._id });
      if (notifyAdmin) {
        await bot.telegram.sendMessage(
          ADMIN_ID,
          '⚠️ Skipped 1 deleted/invalid photo. Moving to the next one.'
        ).catch(() => {});
      }
    }
  }
}

// --- Time-Budgeted Batch Execution (7.5s Cutoff + Auto Roll-over) ---
async function runScheduledBatch(db, startTime) {
  const cfg = await getConfig(db);
  if (!cfg.is_active || cfg.is_posting_locked) return;

  let toPostCount = cfg.pending_batch_count || 0;
  if (toPostCount <= 0) return;

  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { is_posting_locked: true } }
  );

  try {
    while (toPostCount > 0) {
      // Check elapsed time before starting next image (Safe 7.5s cutoff for 10s Vercel limit)
      if (Date.now() - startTime > 7500) {
        break;
      }

      const res = await publishNextQueueItem(db, cfg, true);
      if (res.status === 'empty') {
        toPostCount = 0;
        break;
      }

      if (res.status === 'posted') {
        toPostCount--;
        await db.collection('settings').updateOne(
          { _id: 'main_config' },
          { $set: { pending_batch_count: toPostCount } }
        );
      }
    }
  } finally {
    await db.collection('settings').updateOne(
      { _id: 'main_config' },
      { $set: { pending_batch_count: toPostCount, is_posting_locked: false } }
    );
  }
}

// --- Admin UI Helpers ---
async function renderAdminText(db, cfg) {
  const queueCount = await db.collection('queue').countDocuments({});
  const timesStr = (cfg.schedule_times || []).sort().join(', ') || 'None';
  const frameStatus = cfg.blur_frame ? '🟢' : '🔴';
  const wmStatus = cfg.watermark_enabled ? '🟢' : '🔴';

  return (
    `⚙️ <b>VIP PROMO CONTROL PANEL</b>\n\n` +
    `📊 <b>Status:</b> ${cfg.is_active ? '🟢 ACTIVE' : '🔴 PAUSED'}\n` +
    `📦 <b>Daily Limit:</b> ${cfg.daily_limit} Posts / Day\n` +
    `⏰ <b>Schedule:</b> ${timesStr}\n` +
    `🖼 <b>Queue:</b> ${queueCount} Pending\n` +
    `🎨 <b>Effects:</b> Blur Frame ${frameStatus} | Watermark ${wmStatus}`
  );
}

function getAdminKeyboard(cfg) {
  const activeLabel = cfg.is_active ? '🟢 ACTIVE' : '🔴 PAUSED';
  return Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Post Now', 'admin_post_now')],
    [
      Markup.button.callback('📦 Set Limit', 'admin_ui_limit'),
      Markup.button.callback('⏰ Set Times', 'admin_ui_times')
    ],
    [
      Markup.button.callback('📝 Set Caption', 'admin_ui_caption'),
      Markup.button.callback('🖼 Manage Queue', 'admin_queue_0')
    ],
    [Markup.button.callback('🎨 Image Effects', 'admin_ui_effects')],
    [
      Markup.button.callback(activeLabel, 'admin_toggle_status'),
      Markup.button.callback('🔄 Refresh', 'admin_refresh')
    ]
  ]);
}

function getTimesKeyboard(times) {
  const buttons = [];
  (times || []).sort().forEach((t) => {
    buttons.push([
      Markup.button.callback(`🕒 ${t}`, 'noop'),
      Markup.button.callback('❌ Remove', `del_time_${t}`)
    ]);
  });
  buttons.push([Markup.button.callback('➕ Add Custom Time', 'admin_ui_add_time')]);
  buttons.push([Markup.button.callback('🔙 Back to Menu', 'admin_refresh')]);
  return Markup.inlineKeyboard(buttons);
}

function getEffectsKeyboard(cfg) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `🖼 Blur Frame: ${cfg.blur_frame ? '🟢 ON' : '🔴 OFF'}`,
        'toggle_blur_frame'
      )
    ],
    [
      Markup.button.callback(
        `💧 Watermark: ${cfg.watermark_enabled ? '🟢 ON' : '🔴 OFF'}`,
        'toggle_watermark'
      )
    ],
    [Markup.button.callback('🔙 Back to Menu', 'admin_refresh')]
  ]);
}

// --- Commands (Strictly Admin Only) ---
bot.command('start', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await setupAdminCommands();
  await ctx.replyWithHTML('🤖 <b>Bot is Active & Ready!</b>\nUse /admin to open the control panel.');
});

bot.command('admin', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await setupAdminCommands();
  const db = await getDb();
  const cfg = await getConfig(db);
  await ctx.replyWithHTML(await renderAdminText(db, cfg), getAdminKeyboard(cfg));
});

bot.command('cancel', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { admin_state: null } }
  );
  await ctx.reply('❌ Action cancelled.');
});

// --- Photo Ingestion (Single & Bulk Albums) ---
const albumCounters = new Map();

bot.on('photo', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const db = await getDb();

  const photos = ctx.message.photo;
  const highestResPhoto = photos[photos.length - 1];
  const fileId = highestResPhoto.file_id;
  const msgId = ctx.message.message_id;
  const mediaGroupId = ctx.message.media_group_id;

  const lastItem = await db.collection('queue').find({}).sort({ order: -1 }).limit(1).next();
  const nextOrder = lastItem && typeof lastItem.order === 'number' ? lastItem.order + 1 : msgId;

  await db.collection('queue').insertOne({
    file_id: fileId,
    message_id: msgId,
    order: nextOrder,
    added_at: new Date()
  });

  if (!mediaGroupId) {
    return ctx.reply('✅ Added to queue.');
  }

  // Group album replies cleanly
  const current = albumCounters.get(mediaGroupId) || { count: 0, timer: null };
  current.count += 1;
  if (current.timer) clearTimeout(current.timer);

  current.timer = setTimeout(async () => {
    const total = albumCounters.get(mediaGroupId)?.count || 1;
    albumCounters.delete(mediaGroupId);
    await ctx.reply(`✅ ${total} photos added to queue.`).catch(() => {});
  }, 1200);

  albumCounters.set(mediaGroupId, current);
});

// --- Admin Callback Actions ---
bot.action('noop', (ctx) => ctx.answerCbQuery());

bot.action('admin_refresh', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  const cfg = await getConfig(db);
  await ctx.editMessageText(await renderAdminText(db, cfg), {
    parse_mode: 'HTML',
    ...getAdminKeyboard(cfg)
  }).catch(() => {});
  await ctx.answerCbQuery('Refreshed');
});

bot.action('admin_toggle_status', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  const cfg = await getConfig(db);
  cfg.is_active = !cfg.is_active;

  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { is_active: cfg.is_active } }
  );

  await ctx.editMessageText(await renderAdminText(db, cfg), {
    parse_mode: 'HTML',
    ...getAdminKeyboard(cfg)
  }).catch(() => {});
  await ctx.answerCbQuery(cfg.is_active ? 'Bot Activated' : 'Bot Paused');
});

// Manual Instant Post (Does NOT affect Daily Limit / Schedule)
bot.action('admin_post_now', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  await ctx.answerCbQuery('🚀 Publishing...');
  const db = await getDb();
  const cfg = await getConfig(db);

  await publishNextQueueItem(db, cfg, true);

  await ctx.editMessageText(await renderAdminText(db, cfg), {
    parse_mode: 'HTML',
    ...getAdminKeyboard(cfg)
  }).catch(() => {});
});

// Daily Limit Menu
bot.action('admin_ui_limit', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback('1', 'set_limit_1'),
      Markup.button.callback('2', 'set_limit_2'),
      Markup.button.callback('3', 'set_limit_3'),
      Markup.button.callback('4', 'set_limit_4'),
      Markup.button.callback('5', 'set_limit_5')
    ],
    [
      Markup.button.callback('6', 'set_limit_6'),
      Markup.button.callback('7', 'set_limit_7'),
      Markup.button.callback('8', 'set_limit_8'),
      Markup.button.callback('9', 'set_limit_9'),
      Markup.button.callback('10', 'set_limit_10')
    ],
    [Markup.button.callback('🔙 Back to Menu', 'admin_refresh')]
  ]);

  await ctx.editMessageText('📦 <b>SET DAILY LIMIT</b>\nSelect number of posts per day:', {
    parse_mode: 'HTML',
    ...kb
  }).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action(/set_limit_(\d+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const limit = Number(ctx.match[1]);
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { daily_limit: limit } }
  );
  const cfg = await getConfig(db);
  await ctx.answerCbQuery(`Daily Limit set to ${limit}`);
  await ctx.editMessageText(await renderAdminText(db, cfg), {
    parse_mode: 'HTML',
    ...getAdminKeyboard(cfg)
  }).catch(() => {});
});

// Schedule Times Menu
bot.action('admin_ui_times', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  const cfg = await getConfig(db);
  await ctx.editMessageText(
    '⏰ <b>SCHEDULE TIMES (Sri Lanka Time)</b>\n\nManage your auto-posting times below:',
    {
      parse_mode: 'HTML',
      ...getTimesKeyboard(cfg.schedule_times)
    }
  ).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('admin_ui_add_time', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { admin_state: 'waiting_for_time' } }
  );
  await ctx.reply(
    '✍️ <b>Send posting time in 24h format:</b>\nExample: <code>09:30</code> or <code>20:00</code>\n\n<i>Send /cancel to abort.</i>',
    { parse_mode: 'HTML' }
  );
  await ctx.answerCbQuery();
});

bot.action(/del_time_(.+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const timeToRemove = ctx.match[1];
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $pull: { schedule_times: timeToRemove } }
  );
  const cfg = await getConfig(db);
  await ctx.editMessageText(
    '⏰ <b>SCHEDULE TIMES (Sri Lanka Time)</b>\n\nManage your auto-posting times below:',
    {
      parse_mode: 'HTML',
      ...getTimesKeyboard(cfg.schedule_times)
    }
  ).catch(() => {});
  await ctx.answerCbQuery(`Removed ${timeToRemove}`);
});

// Set Caption Prompt (Preserves Native Telegram Formatting)
bot.action('admin_ui_caption', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { admin_state: 'waiting_for_caption' } }
  );
  await ctx.reply(
    '📝 <b>Send your formatted caption now:</b>\n\nFormat your text directly in Telegram (Bold, Italic, Quote, Emojis) and send it.\n\n<i>Send /cancel to abort.</i>',
    { parse_mode: 'HTML' }
  );
  await ctx.answerCbQuery();
});

// Image Effects Menu (Separate Toggles)
bot.action('admin_ui_effects', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  const cfg = await getConfig(db);
  await ctx.editMessageText(
    '🎨 <b>IMAGE EFFECTS SETTINGS</b>\n\nToggle effects individually below:',
    {
      parse_mode: 'HTML',
      ...getEffectsKeyboard(cfg)
    }
  ).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('toggle_blur_frame', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  const cfg = await getConfig(db);
  cfg.blur_frame = !cfg.blur_frame;
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { blur_frame: cfg.blur_frame } }
  );
  await ctx.editMessageReplyMarkup(getEffectsKeyboard(cfg).reply_markup).catch(() => {});
  await ctx.answerCbQuery(`Blur Frame: ${cfg.blur_frame ? 'ON' : 'OFF'}`);
});

bot.action('toggle_watermark', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  const cfg = await getConfig(db);
  cfg.watermark_enabled = !cfg.watermark_enabled;
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { watermark_enabled: cfg.watermark_enabled } }
  );
  await ctx.editMessageReplyMarkup(getEffectsKeyboard(cfg).reply_markup).catch(() => {});
  await ctx.answerCbQuery(`Watermark: ${cfg.watermark_enabled ? 'ON' : 'OFF'}`);
});

// --- Visual Queue Manager (Browse with Image, Move to Top, Delete) ---
async function sendOrUpdateQueueViewer(ctx, db, index, isNewMessage = false) {
  const items = await db.collection('queue').find({}).sort({ order: 1, message_id: 1, _id: 1 }).toArray();

  if (items.length === 0) {
    if (isNewMessage) {
      return ctx.answerCbQuery('📭 Queue is empty!', { show_alert: true });
    }
    const cfg = await getConfig(db);
    await ctx.deleteMessage().catch(() => {});
    return ctx.replyWithHTML(await renderAdminText(db, cfg), getAdminKeyboard(cfg));
  }

  const safeIndex = Math.max(0, Math.min(index, items.length - 1));
  const item = items[safeIndex];
  const prevIdx = safeIndex > 0 ? safeIndex - 1 : items.length - 1;
  const nextIdx = safeIndex < items.length - 1 ? safeIndex + 1 : 0;

  const caption = `🖼 <b>Queue Item #${safeIndex + 1} of ${items.length}</b>`;
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('⬅️ Prev', `admin_queue_${prevIdx}`),
      Markup.button.callback(`${safeIndex + 1} / ${items.length}`, 'noop'),
      Markup.button.callback('Next ➡️', `admin_queue_${nextIdx}`)
    ],
    [
      Markup.button.callback('⬆️ Move to Top', `q_top_${item._id}`),
      Markup.button.callback('🗑 Delete This', `q_del_${item._id}_${safeIndex}`)
    ],
    [Markup.button.callback('🔙 Back to Panel', 'q_back_panel')]
  ]);

  if (isNewMessage) {
    await ctx.replyWithPhoto(item.file_id, {
      caption,
      parse_mode: 'HTML',
      ...keyboard
    });
  } else {
    await ctx.editMessageMedia(
      {
        type: 'photo',
        media: item.file_id,
        caption,
        parse_mode: 'HTML'
      },
      keyboard
    ).catch(() => {});
  }
}

bot.action(/admin_queue_(\d+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const index = Number(ctx.match[1]);
  const db = await getDb();
  const isFromControlPanel = Boolean(ctx.callbackQuery.message && ctx.callbackQuery.message.text);
  await sendOrUpdateQueueViewer(ctx, db, index, isFromControlPanel);
  await ctx.answerCbQuery().catch(() => {});
});

bot.action(/q_top_(.+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const id = ctx.match[1];
  const db = await getDb();
  const firstItem = await db.collection('queue').find({}).sort({ order: 1 }).limit(1).next();
  const topOrder = firstItem && typeof firstItem.order === 'number' ? firstItem.order - 1 : 0;

  await db.collection('queue').updateOne(
    { _id: new ObjectId(id) },
    { $set: { order: topOrder } }
  );
  await ctx.answerCbQuery('⬆️ Moved to #1!');
  await sendOrUpdateQueueViewer(ctx, db, 0, false);
});

bot.action(/q_del_([^_]+)_(\d+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const id = ctx.match[1];
  const currentIndex = Number(ctx.match[2]);
  const db = await getDb();

  await db.collection('queue').deleteOne({ _id: new ObjectId(id) });
  await ctx.answerCbQuery('🗑 Deleted from queue');
  await sendOrUpdateQueueViewer(ctx, db, currentIndex, false);
});

bot.action('q_back_panel', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  const cfg = await getConfig(db);
  await ctx.deleteMessage().catch(() => {});
  await ctx.replyWithHTML(await renderAdminText(db, cfg), getAdminKeyboard(cfg));
  await ctx.answerCbQuery();
});

// --- Text Input Handler (Times & Formatted Captions) ---
bot.on('text', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const db = await getDb();
  const cfg = await getConfig(db);

  if (cfg.admin_state === 'waiting_for_time') {
    const text = ctx.message.text.trim();
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(text)) {
      return ctx.reply('⚠️ Invalid format! Send time as <code>HH:MM</code> (e.g., <code>09:30</code>):', {
        parse_mode: 'HTML'
      });
    }

    const [h, m] = text.split(':');
    const formattedTime = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;

    await db.collection('settings').updateOne(
      { _id: 'main_config' },
      {
        $addToSet: { schedule_times: formattedTime },
        $set: { admin_state: null }
      }
    );

    const updatedCfg = await getConfig(db);
    return ctx.reply(`✅ <b>${formattedTime}</b> added to schedule!`, {
      parse_mode: 'HTML',
      ...getTimesKeyboard(updatedCfg.schedule_times)
    });
  }

  if (cfg.admin_state === 'waiting_for_caption') {
    const rawText = ctx.message.text;
    const entities = ctx.message.entities || [];

    await db.collection('settings').updateOne(
      { _id: 'main_config' },
      {
        $set: {
          caption_text: rawText,
          caption_entities: entities,
          admin_state: null
        }
      }
    );

    const updatedCfg = await getConfig(db);
    await ctx.reply('✅ <b>Caption saved with your Telegram formatting!</b>', { parse_mode: 'HTML' });
    return ctx.replyWithHTML(await renderAdminText(db, updatedCfg), getAdminKeyboard(updatedCfg));
  }
});

// --- Serverless Entrypoint & Cron Scheduler ---
module.exports = async (req, res) => {
  const startTime = Date.now();

  try {
    const db = await getDb();

    // 1. GitHub Actions Cron Ping (GET)
    if (req.method === 'GET') {
      const cfg = await getConfig(db);

      if (cfg.is_active) {
        // Sri Lanka Time (UTC + 5:30)
        const now = new Date();
        const slDate = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
        const yyyy = slDate.getUTCFullYear();
        const mm = String(slDate.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(slDate.getUTCDate()).padStart(2, '0');
        const dateStr = `${yyyy}-${mm}-${dd}`;

        const curHour = slDate.getUTCHours();
        const curMin = slDate.getUTCMinutes();
        const curTotalMins = curHour * 60 + curMin;

        const times = (cfg.schedule_times || []).sort();

        for (const t of times) {
          const [tH, tM] = t.split(':').map(Number);
          const schedTotalMins = tH * 60 + tM;
          const slotKey = `${dateStr}_${t}`;

          // 20-minute window to absorb GitHub Actions cron jitter without missing or duplicating
          if (
            curTotalMins >= schedTotalMins &&
            curTotalMins <= schedTotalMins + 20 &&
            cfg.last_posted_slot !== slotKey
          ) {
            const postsForThisSlot =
              times.length === 1
                ? cfg.daily_limit
                : Math.max(1, Math.ceil(cfg.daily_limit / times.length));

            await db.collection('settings').updateOne(
              { _id: 'main_config' },
              {
                $set: {
                  last_posted_slot: slotKey,
                  pending_batch_count: (cfg.pending_batch_count || 0) + postsForThisSlot
                }
              }
            );
            break;
          }
        }

        // Execute batch within 7.5s safe budget; remainder rolls over automatically
        await runScheduledBatch(db, startTime);
      }

      return res.status(200).json({ ok: true, status: 'cron_checked' });
    }

    // 2. Telegram Webhook Update (POST)
    if (req.method === 'POST' && req.body) {
      await bot.handleUpdate(req.body);
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(200).json({ ok: false });
  }
};
