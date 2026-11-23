const { Telegraf, Markup } = require('telegraf');
const { MongoClient, ObjectId } = require('mongodb');

// --- Environment Variables ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
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
      serverSelectionTimeoutMS: 6000,
      connectTimeoutMS: 6000
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

// --- Build Zero-CPU Cloudinary Transformation URL ---
async function buildTransformedMedia(fileId, cfg) {
  const useBlur = cfg.blur_frame !== false;
  const useWm = cfg.watermark_enabled !== false;

  if ((!useBlur && !useWm) || !CLOUDINARY_CLOUD_NAME) {
    return fileId;
  }

  const fileLink = await bot.telegram.getFileLink(fileId);
  const rawUrl = fileLink.href;
  const encodedUrl = encodeURIComponent(rawUrl);
  const wmText = encodeURIComponent(cfg.watermark_text || 'Hot Lanka');

  // Case 1: Only Watermark ON (No Blur Frame)
  if (!useBlur && useWm) {
    return (
      `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/fetch/` +
      `f_jpg,q_90/` +
      `l_text:Arial_58_bold:${wmText},co_white,o_35,g_center/` +
      `${encodedUrl}`
    );
  }

  // Case 2: Blur Frame ON (With or Without Watermark)
  const base64Url = Buffer.from(rawUrl)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const wmLayer = useWm
    ? `/l_text:Arial_64_bold:${wmText},co_white,o_35,g_center`
    : '';

  return (
    `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/fetch/` +
    `w_1080,h_1350,c_fill/` +
    `e_blur:1800,e_brightness:-35/` +
    `l_fetch:${base64Url},w_920,h_1210,c_fit,r_24,bo_3px_solid_rgb:ffffff55,g_center` +
    `${wmLayer}/` +
    `f_jpg,q_90/` +
    `${encodedUrl}`
  );
}

// --- Publish Single Next Valid Item from Queue ---
async function publishNextQueueItem(db, cfg, notifyAdmin = true) {
  if (!TARGET_CHANNEL_ID) {
    if (notifyAdmin) {
      await bot.telegram.sendMessage(ADMIN_ID, '❌ TARGET_CHANNEL_ID is missing in Vercel!').catch(() => {});
    }
    return { status: 'error', reason: 'Missing TARGET_CHANNEL_ID' };
  }

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
      const mediaSource = await buildTransformedMedia(nextItem.file_id, cfg);

      const postOptions = {
        caption: cfg.caption_text || '',
        caption_entities: cfg.caption_entities && cfg.caption_entities.length > 0 ? cfg.caption_entities : undefined,
        ...fixedButton
      };

      await bot.telegram.sendPhoto(TARGET_CHANNEL_ID, mediaSource, postOptions);
      await db.collection('queue').deleteOne({ _id: nextItem._id });

      if (notifyAdmin) {
        await bot.telegram.sendMessage(ADMIN_ID, '🚀 Posted to Hot Lanka channel!').catch(() => {});
      }

      return { status: 'posted' };
    } catch (err) {
      if (
        err.message &&
        (err.message.includes('wrong file_id') ||
          err.message.includes('file is temporarily unavailable'))
      ) {
        await db.collection('queue').deleteOne({ _id: nextItem._id });
        if (notifyAdmin) {
          await bot.telegram.sendMessage(
            ADMIN_ID,
            '⚠️ Skipped 1 deleted/invalid photo. Moving to the next one.'
          ).catch(() => {});
        }
      } else {
        if (notifyAdmin) {
          await bot.telegram.sendMessage(
            ADMIN_ID,
            `❌ Error posting: ${err.message}`
          ).catch(() => {});
        }
        return { status: 'error', reason: err.message };
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
      if (Date.now() - startTime > 7500) {
        break;
      }

      const res = await publishNextQueueItem(db, cfg, true);
      if (res.status === 'empty') {
        toPostCount = 0;
        break;
      }
      if (res.status === 'error') {
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
  const frameStatus = cfg.blur_frame !== false ? '🟢' : '🔴';
  const wmStatus = cfg.watermark_enabled !== false ? '🟢' : '🔴';

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
  const blurOn = cfg.blur_frame !== false;
  const wmOn = cfg.watermark_enabled !== false;
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `🖼 Blur Frame: ${blurOn ? '🟢 ON' : '🔴 OFF'}`,
        'toggle_blur_frame'
      )
    ],
    [
      Markup.button.callback(
        `💧 Watermark: ${wmOn ? '🟢 ON' : '🔴 OFF'}`,
        'toggle_watermark'
      )
    ],
    [Markup.button.callback('🔙 Back to Menu', 'admin_refresh')]
  ]);
}

// --- Commands ---
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

// --- Photo Ingestion ---
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
bot.action('noop', (ctx) => ctx.answerCbQuery().catch(() => {}));

bot.action('admin_refresh', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  const db = await getDb();
  const cfg = await getConfig(db);
  await ctx.editMessageText(await renderAdminText(db, cfg), {
    parse_mode: 'HTML',
    ...getAdminKeyboard(cfg)
  }).catch(() => {});
  await ctx.answerCbQuery('Refreshed').catch(() => {});
});

bot.action('admin_toggle_status', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
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
  await ctx.answerCbQuery(cfg.is_active ? 'Bot Activated' : 'Bot Paused').catch(() => {});
});

bot.action('admin_post_now', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  await ctx.answerCbQuery('🚀 Publishing...').catch(() => {});

  const db = await getDb();
  const cfg = await getConfig(db);
  const res = await publishNextQueueItem(db, cfg, true);

  if (res.status === 'empty') {
    await ctx.reply('📭 <b>Queue is empty!</b> Send some screenshots first.', {
      parse_mode: 'HTML'
    }).catch(() => {});
  }

  await ctx.editMessageText(await renderAdminText(db, cfg), {
    parse_mode: 'HTML',
    ...getAdminKeyboard(cfg)
  }).catch(() => {});
});

// Daily Limit Menu
bot.action('admin_ui_limit', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
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
  await ctx.answerCbQuery().catch(() => {});
});

bot.action(/set_limit_(\d+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  const limit = Number(ctx.match[1]);
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { daily_limit: limit } }
  );
  const cfg = await getConfig(db);
  await ctx.answerCbQuery(`Daily Limit set to ${limit}`).catch(() => {});
  await ctx.editMessageText(await renderAdminText(db, cfg), {
    parse_mode: 'HTML',
    ...getAdminKeyboard(cfg)
  }).catch(() => {});
});

// Schedule Times Menu
bot.action('admin_ui_times', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  const db = await getDb();
  const cfg = await getConfig(db);
  await ctx.editMessageText(
    '⏰ <b>SCHEDULE TIMES (Sri Lanka Time)</b>\n\nManage your auto-posting times below:',
    {
      parse_mode: 'HTML',
      ...getTimesKeyboard(cfg.schedule_times)
    }
  ).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
});

bot.action('admin_ui_add_time', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { admin_state: 'waiting_for_time' } }
  );
  await ctx.reply(
    '✍️ <b>Send posting time in 24h format:</b>\nExample: <code>09:30</code> or <code>20:00</code>\n\n<i>Send /cancel to abort.</i>',
    { parse_mode: 'HTML' }
  );
  await ctx.answerCbQuery().catch(() => {});
});

bot.action(/del_time_(.+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
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
  await ctx.answerCbQuery(`Removed ${timeToRemove}`).catch(() => {});
});

// Set Caption
bot.action('admin_ui_caption', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { admin_state: 'waiting_for_caption' } }
  );
  await ctx.reply(
    '📝 <b>Send your formatted caption now:</b>\n\nFormat your text directly in Telegram (Bold, Italic, Quote, Emojis) and send it.\n\n<i>Send /cancel to abort.</i>',
    { parse_mode: 'HTML' }
  );
  await ctx.answerCbQuery().catch(() => {});
});

// Image Effects Menu
bot.action('admin_ui_effects', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  const db = await getDb();
  const cfg = await getConfig(db);
  await ctx.editMessageText(
    '🎨 <b>IMAGE EFFECTS SETTINGS</b>\n\nToggle effects individually below:',
    {
      parse_mode: 'HTML',
      ...getEffectsKeyboard(cfg)
    }
  ).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
});

bot.action('toggle_blur_frame', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  const db = await getDb();
  const cfg = await getConfig(db);
  cfg.blur_frame = cfg.blur_frame === false ? true : false;
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { blur_frame: cfg.blur_frame } }
  );
  await ctx.editMessageReplyMarkup(getEffectsKeyboard(cfg).reply_markup).catch(() => {});
  await ctx.answerCbQuery(`Blur Frame: ${cfg.blur_frame ? 'ON' : 'OFF'}`).catch(() => {});
});

bot.action('toggle_watermark', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  const db = await getDb();
  const cfg = await getConfig(db);
  cfg.watermark_enabled = cfg.watermark_enabled === false ? true : false;
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { watermark_enabled: cfg.watermark_enabled } }
  );
  await ctx.editMessageReplyMarkup(getEffectsKeyboard(cfg).reply_markup).catch(() => {});
  await ctx.answerCbQuery(`Watermark: ${cfg.watermark_enabled ? 'ON' : 'OFF'}`).catch(() => {});
});

// --- Visual Queue Manager ---
async function sendOrUpdateQueueViewer(ctx, db, index, isNewMessage = false) {
  const items = await db.collection('queue').find({}).sort({ order: 1, message_id: 1, _id: 1 }).toArray();

  if (items.length === 0) {
    if (isNewMessage) {
      return ctx.answerCbQuery('📭 Queue is empty!', { show_alert: true }).catch(() => {});
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
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  const index = Number(ctx.match[1]);
  const db = await getDb();
  const isFromControlPanel = Boolean(ctx.callbackQuery.message && ctx.callbackQuery.message.text);
  await sendOrUpdateQueueViewer(ctx, db, index, isFromControlPanel);
  await ctx.answerCbQuery().catch(() => {});
});

bot.action(/q_top_(.+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  const id = ctx.match[1];
  const db = await getDb();
  const firstItem = await db.collection('queue').find({}).sort({ order: 1 }).limit(1).next();
  const topOrder = firstItem && typeof firstItem.order === 'number' ? firstItem.order - 1 : 0;

  await db.collection('queue').updateOne(
    { _id: new ObjectId(id) },
    { $set: { order: topOrder } }
  );
  await ctx.answerCbQuery('⬆️ Moved to #1!').catch(() => {});
  await sendOrUpdateQueueViewer(ctx, db, 0, false);
});

bot.action(/q_del_([^_]+)_(\d+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  const id = ctx.match[1];
  const currentIndex = Number(ctx.match[2]);
  const db = await getDb();

  await db.collection('queue').deleteOne({ _id: new ObjectId(id) });
  await ctx.answerCbQuery('🗑 Deleted from queue').catch(() => {});
  await sendOrUpdateQueueViewer(ctx, db, currentIndex, false);
});

bot.action('q_back_panel', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  const db = await getDb();
  const cfg = await getConfig(db);
  await ctx.deleteMessage().catch(() => {});
  await ctx.replyWithHTML(await renderAdminText(db, cfg), getAdminKeyboard(cfg));
  await ctx.answerCbQuery().catch(() => {});
});

// --- Text Input Handler ---
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
