const { Telegraf, Markup } = require('telegraf');
const { MongoClient, ObjectId } = require('mongodb');

// --- Environment Variables ---
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
        { command: 'clearphotos', description: 'Clear All Photos from Queue' },
        { command: 'clearvideos', description: 'Clear All Videos from Queue' },
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

// --- Sri Lanka Date & Time Helper ---
function getSLDateTime() {
  const now = new Date();
  const slDate = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const yyyy = slDate.getUTCFullYear();
  const mm = String(slDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(slDate.getUTCDate()).padStart(2, '0');
  return {
    dateStr: `${yyyy}-${mm}-${dd}`,
    curTotalMins: slDate.getUTCHours() * 60 + slDate.getUTCMinutes()
  };
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
      video_caption_text: '🎬 NEW VIP VIDEO PREVIEW!\n\n✅ Watch Full Uncut Video inside VIP.\n💰 VIP Access: Rs. 500/= Only',
      video_caption_entities: [],
      pending_batch_count: 0,
      last_posted_slot: null,
      last_posted_media_type: 'video',
      today_date: null,
      today_posted_count: 0,
      is_posting_locked: false,
      lock_timestamp: 0,
      admin_state: null,
      panel_msg_id: null,
      preview_msg_id: null,
      preview_hint_id: null
    };
    await db.collection('settings').insertOne(cfg);
  }
  return cfg;
}

// --- Get Caption & Entities Based on Media Type (Photo vs Video/GIF) ---
function getCaptionPayload(cfg, itemType) {
  const isMotion = itemType === 'video' || itemType === 'animation';
  if (isMotion) {
    const text = cfg.video_caption_text !== undefined ? cfg.video_caption_text : (cfg.caption_text || '');
    const entities = cfg.video_caption_text !== undefined
      ? (cfg.video_caption_entities || [])
      : (cfg.caption_entities || []);
    return {
      caption: text,
      caption_entities: entities.length > 0 ? entities : undefined
    };
  }
  const text = cfg.caption_text || '';
  const entities = cfg.caption_entities || [];
  return {
    caption: text,
    caption_entities: entities.length > 0 ? entities : undefined
  };
}

// --- Pick Next Item Following Photo -> Video/GIF -> Photo Alternation ---
async function pickNextAlternatingItem(db, cfg) {
  const lastType = cfg.last_posted_media_type || 'video';
  const preferredGroup = lastType === 'photo' ? 'motion' : 'photo';

  const photoQuery = { $or: [{ media_type: 'photo' }, { media_type: { $exists: false } }] };
  const motionQuery = { media_type: { $in: ['video', 'animation'] } };

  const primaryQuery = preferredGroup === 'motion' ? motionQuery : photoQuery;
  const fallbackQuery = preferredGroup === 'motion' ? photoQuery : motionQuery;

  let item = await db.collection('queue')
    .find(primaryQuery)
    .sort({ order: 1, message_id: 1, _id: 1 })
    .limit(1)
    .next();

  if (!item) {
    item = await db.collection('queue')
      .find(fallbackQuery)
      .sort({ order: 1, message_id: 1, _id: 1 })
      .limit(1)
      .next();
  }

  return item;
}

// --- Publish Single Next Valid Item from Queue (Direct file_id — Zero External Processing) ---
async function publishNextQueueItem(db, cfg) {
  if (!TARGET_CHANNEL_ID) {
    return { status: 'error', reason: 'Missing TARGET_CHANNEL_ID' };
  }

  const fixedButton = Markup.inlineKeyboard([
    [Markup.button.url('Contact Admin', CONTACT_ADMIN_URL)]
  ]);

  while (true) {
    const nextItem = await pickNextAlternatingItem(db, cfg);

    if (!nextItem) {
      return { status: 'empty' };
    }

    const itemType = nextItem.media_type === 'animation'
      ? 'animation'
      : nextItem.media_type === 'video'
        ? 'video'
        : 'photo';

    try {
      const captionPayload = getCaptionPayload(cfg, itemType);
      const postOptions = {
        ...captionPayload,
        ...fixedButton
      };

      if (itemType === 'video') {
        await bot.telegram.sendVideo(TARGET_CHANNEL_ID, nextItem.file_id, {
          ...postOptions,
          supports_streaming: true
        });
      } else if (itemType === 'animation') {
        await bot.telegram.sendAnimation(TARGET_CHANNEL_ID, nextItem.file_id, postOptions);
      } else {
        await bot.telegram.sendPhoto(TARGET_CHANNEL_ID, nextItem.file_id, postOptions);
      }

      await db.collection('queue').deleteOne({ _id: nextItem._id });

      const groupMarker = itemType === 'photo' ? 'photo' : 'video';
      cfg.last_posted_media_type = groupMarker;
      await db.collection('settings').updateOne(
        { _id: 'main_config' },
        { $set: { last_posted_media_type: groupMarker } }
      );

      return { status: 'posted', mediaType: itemType };
    } catch (err) {
      if (
        err.message &&
        (err.message.includes('wrong file_id') ||
          err.message.includes('file is temporarily unavailable'))
      ) {
        await db.collection('queue').deleteOne({ _id: nextItem._id });
      } else {
        return { status: 'error', reason: err.message };
      }
    }
  }
}

// --- Time-Budgeted Batch Execution (Auto-Unlock + 5s Safe Cutoff + Exact Daily Cap) ---
async function runScheduledBatch(db, startTime) {
  const cfg = await getConfig(db);
  if (!cfg.is_active) return;

  const lockAge = Date.now() - (cfg.lock_timestamp || 0);
  if (cfg.is_posting_locked && lockAge < 90000) {
    return;
  }

  const { dateStr } = getSLDateTime();
  const dailyLimit = Number(cfg.daily_limit) || 0;
  let todayPosted = cfg.today_date === dateStr ? (cfg.today_posted_count || 0) : 0;
  let remainingToday = Math.max(0, dailyLimit - todayPosted);

  let toPostCount = Math.min(cfg.pending_batch_count || 0, remainingToday);
  if (toPostCount <= 0) {
    if ((cfg.pending_batch_count || 0) > 0 || cfg.is_posting_locked) {
      await db.collection('settings').updateOne(
        { _id: 'main_config' },
        { $set: { pending_batch_count: 0, is_posting_locked: false, lock_timestamp: 0 } }
      );
    }
    return;
  }

  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { is_posting_locked: true, lock_timestamp: Date.now() } }
  );

  let postedAny = false;

  try {
    while (toPostCount > 0 && remainingToday > 0) {
      if (Date.now() - startTime > 5000) {
        break;
      }

      const res = await publishNextQueueItem(db, cfg);
      if (res.status === 'empty') {
        toPostCount = 0;
        break;
      }
      if (res.status === 'error') {
        break;
      }
      if (res.status === 'posted') {
        postedAny = true;
        toPostCount--;
        todayPosted++;
        remainingToday--;
        await db.collection('settings').updateOne(
          { _id: 'main_config' },
          {
            $set: {
              pending_batch_count: toPostCount,
              today_date: dateStr,
              today_posted_count: todayPosted,
              lock_timestamp: Date.now()
            }
          }
        );
      }
    }
  } finally {
    await db.collection('settings').updateOne(
      { _id: 'main_config' },
      { $set: { pending_batch_count: toPostCount, is_posting_locked: false, lock_timestamp: 0 } }
    );

    if (postedAny && cfg.panel_msg_id && !cfg.admin_state) {
      const updatedCfg = await getConfig(db);
      await bot.telegram.editMessageText(
        ADMIN_ID,
        cfg.panel_msg_id,
        undefined,
        await renderAdminText(db, updatedCfg),
        { parse_mode: 'HTML', ...getAdminKeyboard(updatedCfg) }
      ).catch(() => {});
    }
  }
}

// --- Admin UI Helpers ---
async function renderAdminText(db, cfg) {
  const photoCount = await db.collection('queue').countDocuments({
    $or: [{ media_type: 'photo' }, { media_type: { $exists: false } }]
  });
  const videoCount = await db.collection('queue').countDocuments({
    media_type: { $in: ['video', 'animation'] }
  });
  const totalCount = photoCount + videoCount;

  const timesStr = (cfg.schedule_times || []).sort().join(', ') || 'None';
  const queueDetail = `${totalCount} Pending (🖼 ${photoCount} | 🎬 ${videoCount})`;

  return (
    `⚙️ <b>VIP PROMO CONTROL PANEL</b>\n\n` +
    `📊 <b>Status:</b> ${cfg.is_active ? '🟢 ACTIVE' : '🔴 PAUSED'}\n` +
    `📦 <b>Daily Limit:</b> ${cfg.daily_limit} Posts / Day\n` +
    `⏰ <b>Schedule:</b> ${timesStr}\n` +
    `🖼 <b>Queue:</b> ${queueDetail}`
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
      Markup.button.callback('🖼 Manage Queue', 'admin_ui_queue_menu')
    ],
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

// --- Commands ---
bot.command('start', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await setupAdminCommands();
  await ctx.deleteMessage().catch(() => {});
  const db = await getDb();
  const cfg = await getConfig(db);
  const sent = await ctx.replyWithHTML(await renderAdminText(db, cfg), getAdminKeyboard(cfg));
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { panel_msg_id: sent.message_id, admin_state: null } }
  );
});

bot.command('admin', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await setupAdminCommands();
  await ctx.deleteMessage().catch(() => {});
  const db = await getDb();
  const cfg = await getConfig(db);

  if (cfg.panel_msg_id) {
    await bot.telegram.deleteMessage(ADMIN_ID, cfg.panel_msg_id).catch(() => {});
  }

  const sent = await ctx.replyWithHTML(await renderAdminText(db, cfg), getAdminKeyboard(cfg));
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { panel_msg_id: sent.message_id, admin_state: null } }
  );
});

bot.command('clearphotos', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.deleteMessage().catch(() => {});
  const db = await getDb();
  const res = await db.collection('queue').deleteMany({
    $or: [{ media_type: 'photo' }, { media_type: { $exists: false } }]
  });
  const cfg = await getConfig(db);
  if (cfg.panel_msg_id) {
    await bot.telegram.editMessageText(
      ADMIN_ID,
      cfg.panel_msg_id,
      undefined,
      await renderAdminText(db, cfg),
      { parse_mode: 'HTML', ...getAdminKeyboard(cfg) }
    ).catch(() => {});
  }
  const notice = await ctx.reply(`🗑 Cleared ${res.deletedCount} photo(s) from queue.`);
  setTimeout(() => {
    bot.telegram.deleteMessage(ADMIN_ID, notice.message_id).catch(() => {});
  }, 3500);
});

bot.command('clearvideos', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.deleteMessage().catch(() => {});
  const db = await getDb();
  const res = await db.collection('queue').deleteMany({
    media_type: { $in: ['video', 'animation'] }
  });
  const cfg = await getConfig(db);
  if (cfg.panel_msg_id) {
    await bot.telegram.editMessageText(
      ADMIN_ID,
      cfg.panel_msg_id,
      undefined,
      await renderAdminText(db, cfg),
      { parse_mode: 'HTML', ...getAdminKeyboard(cfg) }
    ).catch(() => {});
  }
  const notice = await ctx.reply(`🗑 Cleared ${res.deletedCount} video(s) from queue.`);
  setTimeout(() => {
    bot.telegram.deleteMessage(ADMIN_ID, notice.message_id).catch(() => {});
  }, 3500);
});

bot.command('cancel', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.deleteMessage().catch(() => {});
  const db = await getDb();
  const cfg = await getConfig(db);
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { admin_state: null } }
  );

  if (cfg.panel_msg_id) {
    await bot.telegram.editMessageText(
      ADMIN_ID,
      cfg.panel_msg_id,
      undefined,
      await renderAdminText(db, cfg),
      { parse_mode: 'HTML', ...getAdminKeyboard(cfg) }
    ).catch(() => {});
  }
});

// --- Media Ingestion (Photos, Videos & Animations/GIFs) ---
const albumCounters = new Map();

async function handleMediaIngestion(ctx, fileId, mediaType) {
  const db = await getDb();
  const msgId = ctx.message.message_id;
  const mediaGroupId = ctx.message.media_group_id;

  const lastItem = await db.collection('queue').find({}).sort({ order: -1 }).limit(1).next();
  const nextOrder = lastItem && typeof lastItem.order === 'number' ? lastItem.order + 1 : msgId;

  await db.collection('queue').insertOne({
    file_id: fileId,
    media_type: mediaType,
    message_id: msgId,
    order: nextOrder,
    added_at: new Date()
  });

  if (!mediaGroupId) {
    const label = mediaType === 'video' || mediaType === 'animation'
      ? '🎬 Video added to queue.'
      : '✅ Photo added to queue.';
    await ctx.reply(label);
    const cfg = await getConfig(db);
    if (cfg.panel_msg_id && !cfg.admin_state) {
      await bot.telegram.editMessageText(
        ADMIN_ID,
        cfg.panel_msg_id,
        undefined,
        await renderAdminText(db, cfg),
        { parse_mode: 'HTML', ...getAdminKeyboard(cfg) }
      ).catch(() => {});
    }
    return;
  }

  const current = albumCounters.get(mediaGroupId) || { count: 0, timer: null };
  current.count += 1;
  if (current.timer) clearTimeout(current.timer);

  current.timer = setTimeout(async () => {
    const total = albumCounters.get(mediaGroupId)?.count || 1;
    albumCounters.delete(mediaGroupId);
    await ctx.reply(`✅ ${total} items added to queue.`).catch(() => {});
    const cfg = await getConfig(db);
    if (cfg.panel_msg_id && !cfg.admin_state) {
      await bot.telegram.editMessageText(
        ADMIN_ID,
        cfg.panel_msg_id,
        undefined,
        await renderAdminText(db, cfg),
        { parse_mode: 'HTML', ...getAdminKeyboard(cfg) }
      ).catch(() => {});
    }
  }, 1200);

  albumCounters.set(mediaGroupId, current);
}

bot.on('photo', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const photos = ctx.message.photo;
  const highestResPhoto = photos[photos.length - 1];
  await handleMediaIngestion(ctx, highestResPhoto.file_id, 'photo');
});

bot.on('video', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await handleMediaIngestion(ctx, ctx.message.video.file_id, 'video');
});

bot.on('animation', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await handleMediaIngestion(ctx, ctx.message.animation.file_id, 'animation');
});

// --- Admin Callback Actions ---
bot.action('noop', (ctx) => ctx.answerCbQuery().catch(() => {}));

bot.action('admin_refresh', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  const db = await getDb();
  const msgId = ctx.callbackQuery.message?.message_id;
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { admin_state: null, panel_msg_id: msgId } }
  );
  const cfg = await getConfig(db);
  await ctx.editMessageText(await renderAdminText(db, cfg), {
    parse_mode: 'HTML',
    ...getAdminKeyboard(cfg)
  }).catch(() => {});
  await ctx.answerCbQuery('🔄 Refreshed').catch(() => {});
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
  await ctx.answerCbQuery(cfg.is_active ? '🟢 Bot Activated' : '🔴 Bot Paused').catch(() => {});
});

// --- Instant Post Now (Popup Alert Only + Auto-Update Panel) ---
bot.action('admin_post_now', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});

  const db = await getDb();
  const cfg = await getConfig(db);
  const res = await publishNextQueueItem(db, cfg);

  if (res.status === 'posted') {
    const typeLabel = res.mediaType === 'photo' ? '🖼 Photo' : '🎬 Video';
    await ctx.answerCbQuery(`🚀 ${typeLabel} posted to Hot Lanka channel!`, { show_alert: true }).catch(() => {});
  } else if (res.status === 'empty') {
    await ctx.answerCbQuery('📭 Queue is empty! Send some photos or videos first.', { show_alert: true }).catch(() => {});
  } else {
    await ctx.answerCbQuery(`❌ Failed: ${res.reason || 'Unknown error'}`, { show_alert: true }).catch(() => {});
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
  await ctx.answerCbQuery(`✅ Daily Limit set to ${limit}`).catch(() => {});
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
  const msgId = ctx.callbackQuery.message?.message_id;
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { admin_state: 'waiting_for_time', panel_msg_id: msgId } }
  );
  await ctx.editMessageText(
    '✍️ <b>ADD POSTING TIME</b>\n\nSend time in 24h format (e.g., <code>09:30</code> or <code>20:00</code>):',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'admin_ui_times')]])
    }
  ).catch(() => {});
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
  await ctx.answerCbQuery(`🗑 Removed ${timeToRemove}`).catch(() => {});
});

// --- Set Caption Menu (Photo Caption & Video Caption + Post Preview) ---
bot.action('admin_ui_caption', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  const db = await getDb();
  const msgId = ctx.callbackQuery.message?.message_id;
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { admin_state: null, panel_msg_id: msgId } }
  );

  await ctx.editMessageText(
    '📝 <b>CAPTION SETTINGS</b>\n\nChoose which post caption you want to edit or preview:',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🖼 Photo Caption', 'cap_menu_photo'),
          Markup.button.callback('🎬 Video Caption', 'cap_menu_video')
        ],
        [Markup.button.callback('🔙 Back to Menu', 'admin_refresh')]
      ])
    }
  ).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
});

bot.action('cap_menu_photo', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  const db = await getDb();
  const msgId = ctx.callbackQuery.message?.message_id;
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { admin_state: 'waiting_for_photo_caption', panel_msg_id: msgId } }
  );

  await ctx.editMessageText(
    '🖼 <b>SET PHOTO CAPTION</b>\n\n' +
    'Type and send your formatted caption for <b>Photos</b> now (Bold, Italic, Quote, Emojis),\n' +
    'or tap <b>Preview Post</b> below to see how it looks with a queued photo:',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('👁 Preview Post', 'preview_post_photo')],
        [Markup.button.callback('🔙 Back', 'admin_ui_caption')]
      ])
    }
  ).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
});

bot.action('cap_menu_video', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  const db = await getDb();
  const msgId = ctx.callbackQuery.message?.message_id;
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { admin_state: 'waiting_for_video_caption', panel_msg_id: msgId } }
  );

  await ctx.editMessageText(
    '🎬 <b>SET VIDEO CAPTION</b>\n\n' +
    'Type and send your formatted caption for <b>Videos</b> now (Bold, Italic, Quote, Emojis),\n' +
    'or tap <b>Preview Post</b> below to see how it looks with a queued video:',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('👁 Preview Post', 'preview_post_video')],
        [Markup.button.callback('🔙 Back', 'admin_ui_caption')]
      ])
    }
  ).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
});

// Non-Destructive Post Preview with Reply Keyboard "🗑 Close Preview"
bot.action(/preview_post_(photo|video)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  const targetType = ctx.match[1];
  const db = await getDb();
  const cfg = await getConfig(db);

  if (cfg.preview_msg_id) {
    await bot.telegram.deleteMessage(ADMIN_ID, cfg.preview_msg_id).catch(() => {});
  }
  if (cfg.preview_hint_id) {
    await bot.telegram.deleteMessage(ADMIN_ID, cfg.preview_hint_id).catch(() => {});
  }

  const postInlineKeyboard = Markup.inlineKeyboard([
    [Markup.button.url('Contact Admin', CONTACT_ADMIN_URL)]
  ]);

  const replyCloseKeyboard = {
    reply_markup: {
      keyboard: [[{ text: '🗑 Close Preview' }]],
      resize_keyboard: true
    }
  };

  if (targetType === 'photo') {
    const samplePhoto = await db.collection('queue')
      .find({ $or: [{ media_type: 'photo' }, { media_type: { $exists: false } }] })
      .sort({ order: 1, message_id: 1, _id: 1 })
      .limit(1)
      .next();

    if (!samplePhoto) {
      return ctx.answerCbQuery('📭 No photos in queue to preview! Send a photo first.', { show_alert: true }).catch(() => {});
    }

    await ctx.answerCbQuery().catch(() => {});
    try {
      const sentAnchor = await ctx.reply('👁 <i>Preview Mode</i>', {
        parse_mode: 'HTML',
        ...replyCloseKeyboard
      });
      const captionPayload = getCaptionPayload(cfg, 'photo');
      const sentPreview = await ctx.replyWithPhoto(samplePhoto.file_id, {
        ...captionPayload,
        ...postInlineKeyboard
      });
      await db.collection('settings').updateOne(
        { _id: 'main_config' },
        { $set: { preview_msg_id: sentPreview.message_id, preview_hint_id: sentAnchor.message_id } }
      );
    } catch (err) {
      await ctx.answerCbQuery(`❌ Preview failed: ${err.message}`, { show_alert: true }).catch(() => {});
    }
    return;
  }

  const sampleVideo = await db.collection('queue')
    .find({ media_type: { $in: ['video', 'animation'] } })
    .sort({ order: 1, message_id: 1, _id: 1 })
    .limit(1)
    .next();

  if (!sampleVideo) {
    return ctx.answerCbQuery('📭 No videos in queue to preview! Send a video first.', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery().catch(() => {});
  try {
    const sentAnchor = await ctx.reply('👁 <i>Preview Mode</i>', {
      parse_mode: 'HTML',
      ...replyCloseKeyboard
    });
    const captionPayload = getCaptionPayload(cfg, 'video');
    let sentPreview;
    if (sampleVideo.media_type === 'animation') {
      sentPreview = await ctx.replyWithAnimation(sampleVideo.file_id, {
        ...captionPayload,
        ...postInlineKeyboard
      });
    } else {
      sentPreview = await ctx.replyWithVideo(sampleVideo.file_id, {
        ...captionPayload,
        supports_streaming: true,
        ...postInlineKeyboard
      });
    }
    await db.collection('settings').updateOne(
      { _id: 'main_config' },
      { $set: { preview_msg_id: sentPreview.message_id, preview_hint_id: sentAnchor.message_id } }
    );
  } catch (err) {
    await ctx.answerCbQuery(`❌ Preview failed: ${err.message}`, { show_alert: true }).catch(() => {});
  }
});

// --- Queue Management Hub (Browse Queue + Clear Photos / Clear Videos Buttons) ---
async function renderQueueMenuText(db) {
  const photoCount = await db.collection('queue').countDocuments({
    $or: [{ media_type: 'photo' }, { media_type: { $exists: false } }]
  });
  const videoCount = await db.collection('queue').countDocuments({
    media_type: { $in: ['video', 'animation'] }
  });
  return (
    `🖼 <b>MANAGE QUEUE</b>\n\n` +
    `🖼 <b>Photos in Queue:</b> ${photoCount}\n` +
    `🎬 <b>Videos in Queue:</b> ${videoCount}\n\n` +
    `Browse items individually or clear a specific media type below:`
  );
}

function getQueueMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔍 Browse Queue Items', 'admin_queue_0')],
    [
      Markup.button.callback('🗑 Clear All Photos', 'confirm_clear_photos'),
      Markup.button.callback('🗑 Clear All Videos', 'confirm_clear_videos')
    ],
    [Markup.button.callback('🔙 Back to Menu', 'admin_refresh')]
  ]);
}

bot.action('admin_ui_queue_menu', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  const db = await getDb();
  await ctx.editMessageText(await renderQueueMenuText(db), {
    parse_mode: 'HTML',
    ...getQueueMenuKeyboard()
  }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
});

bot.action('confirm_clear_photos', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  await ctx.editMessageText(
    '⚠️ <b>CLEAR ALL PHOTOS?</b>\n\nAre you sure you want to remove all queued photos? (Videos will stay untouched)',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Yes, Clear Photos', 'exec_clear_photos'),
          Markup.button.callback('❌ Cancel', 'admin_ui_queue_menu')
        ]
      ])
    }
  ).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
});

bot.action('exec_clear_photos', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  const db = await getDb();
  const res = await db.collection('queue').deleteMany({
    $or: [{ media_type: 'photo' }, { media_type: { $exists: false } }]
  });
  await ctx.answerCbQuery(`🗑 Cleared ${res.deletedCount} photo(s)!`, { show_alert: true }).catch(() => {});
  await ctx.editMessageText(await renderQueueMenuText(db), {
    parse_mode: 'HTML',
    ...getQueueMenuKeyboard()
  }).catch(() => {});
});

bot.action('confirm_clear_videos', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  await ctx.editMessageText(
    '⚠️ <b>CLEAR ALL VIDEOS?</b>\n\nAre you sure you want to remove all queued videos? (Photos will stay untouched)',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Yes, Clear Videos', 'exec_clear_videos'),
          Markup.button.callback('❌ Cancel', 'admin_ui_queue_menu')
        ]
      ])
    }
  ).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
});

bot.action('exec_clear_videos', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery().catch(() => {});
  const db = await getDb();
  const res = await db.collection('queue').deleteMany({
    media_type: { $in: ['video', 'animation'] }
  });
  await ctx.answerCbQuery(`🗑 Cleared ${res.deletedCount} video(s)!`, { show_alert: true }).catch(() => {});
  await ctx.editMessageText(await renderQueueMenuText(db), {
    parse_mode: 'HTML',
    ...getQueueMenuKeyboard()
  }).catch(() => {});
});

// --- Visual Queue Viewer ---
async function sendOrUpdateQueueViewer(ctx, db, index, isNewMessage = false) {
  const items = await db.collection('queue').find({}).sort({ order: 1, message_id: 1, _id: 1 }).toArray();

  if (items.length === 0) {
    if (isNewMessage) {
      return ctx.answerCbQuery('📭 Queue is empty!', { show_alert: true }).catch(() => {});
    }
    const cfg = await getConfig(db);
    await ctx.deleteMessage().catch(() => {});
    if (cfg.panel_msg_id) {
      await bot.telegram.editMessageText(
        ADMIN_ID,
        cfg.panel_msg_id,
        undefined,
        await renderAdminText(db, cfg),
        { parse_mode: 'HTML', ...getAdminKeyboard(cfg) }
      ).catch(() => {});
    }
    return;
  }

  const safeIndex = Math.max(0, Math.min(index, items.length - 1));
  const item = items[safeIndex];
  const mType = item.media_type === 'animation'
    ? 'animation'
    : item.media_type === 'video'
      ? 'video'
      : 'photo';

  const prevIdx = safeIndex > 0 ? safeIndex - 1 : items.length - 1;
  const nextIdx = safeIndex < items.length - 1 ? safeIndex + 1 : 0;

  const badge = mType === 'photo' ? '🖼 Photo' : '🎬 Video';
  const caption = `${badge} — <b>Queue Item #${safeIndex + 1} of ${items.length}</b>`;
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
    if (mType === 'video') {
      await ctx.replyWithVideo(item.file_id, {
        caption,
        parse_mode: 'HTML',
        ...keyboard
      });
    } else if (mType === 'animation') {
      await ctx.replyWithAnimation(item.file_id, {
        caption,
        parse_mode: 'HTML',
        ...keyboard
      });
    } else {
      await ctx.replyWithPhoto(item.file_id, {
        caption,
        parse_mode: 'HTML',
        ...keyboard
      });
    }
  } else {
    await ctx.editMessageMedia(
      {
        type: mType,
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
  if (cfg.panel_msg_id) {
    await bot.telegram.editMessageText(
      ADMIN_ID,
      cfg.panel_msg_id,
      undefined,
      await renderAdminText(db, cfg),
      { parse_mode: 'HTML', ...getAdminKeyboard(cfg) }
    ).catch(() => {});
  } else {
    const sent = await ctx.replyWithHTML(await renderAdminText(db, cfg), getAdminKeyboard(cfg));
    await db.collection('settings').updateOne(
      { _id: 'main_config' },
      { $set: { panel_msg_id: sent.message_id } }
    );
  }
  await ctx.answerCbQuery().catch(() => {});
});

// --- Text Input Handler ---
bot.on('text', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const db = await getDb();
  const cfg = await getConfig(db);
  const rawText = ctx.message.text;

  if (rawText.trim() === '🗑 Close Preview') {
    await ctx.deleteMessage().catch(() => {});
    if (cfg.preview_msg_id) {
      await bot.telegram.deleteMessage(ADMIN_ID, cfg.preview_msg_id).catch(() => {});
    }
    if (cfg.preview_hint_id) {
      await bot.telegram.deleteMessage(ADMIN_ID, cfg.preview_hint_id).catch(() => {});
    }
    await db.collection('settings').updateOne(
      { _id: 'main_config' },
      { $set: { preview_msg_id: null, preview_hint_id: null } }
    );
    const removedMsg = await ctx.reply('✅ Preview closed.', Markup.removeKeyboard());
    await bot.telegram.deleteMessage(ADMIN_ID, removedMsg.message_id).catch(() => {});
    return;
  }

  if (cfg.admin_state === 'waiting_for_time') {
    const text = rawText.trim();
    await ctx.deleteMessage().catch(() => {});
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;

    if (!timeRegex.test(text)) {
      if (cfg.panel_msg_id) {
        await bot.telegram.editMessageText(
          ADMIN_ID,
          cfg.panel_msg_id,
          undefined,
          '⚠️ <b>Invalid format!</b>\nSend time in 24h format (e.g., <code>09:30</code> or <code>20:00</code>):',
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'admin_ui_times')]])
          }
        ).catch(() => {});
      }
      return;
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
    if (cfg.panel_msg_id) {
      await bot.telegram.editMessageText(
        ADMIN_ID,
        cfg.panel_msg_id,
        undefined,
        `⏰ <b>SCHEDULE TIMES (Sri Lanka Time)</b>\n\n✅ Added <b>${formattedTime}</b>!`,
        {
          parse_mode: 'HTML',
          ...getTimesKeyboard(updatedCfg.schedule_times)
        }
      ).catch(() => {});
    }
    return;
  }

  if (cfg.admin_state === 'waiting_for_photo_caption') {
    const entities = ctx.message.entities || [];
    await ctx.deleteMessage().catch(() => {});

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

    if (cfg.panel_msg_id) {
      await bot.telegram.editMessageText(
        ADMIN_ID,
        cfg.panel_msg_id,
        undefined,
        '🖼 <b>PHOTO CAPTION UPDATED!</b>\n\nTap <b>Preview Post</b> below to verify how it looks:',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('👁 Preview Post', 'preview_post_photo')],
            [Markup.button.callback('🔙 Back to Menu', 'admin_refresh')]
          ])
        }
      ).catch(() => {});
    }
    return;
  }

  if (cfg.admin_state === 'waiting_for_video_caption') {
    const entities = ctx.message.entities || [];
    await ctx.deleteMessage().catch(() => {});

    await db.collection('settings').updateOne(
      { _id: 'main_config' },
      {
        $set: {
          video_caption_text: rawText,
          video_caption_entities: entities,
          admin_state: null
        }
      }
    );

    if (cfg.panel_msg_id) {
      await bot.telegram.editMessageText(
        ADMIN_ID,
        cfg.panel_msg_id,
        undefined,
        '🎬 <b>VIDEO CAPTION UPDATED!</b>\n\nTap <b>Preview Post</b> below to verify how it looks:',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('👁 Preview Post', 'preview_post_video')],
            [Markup.button.callback('🔙 Back to Menu', 'admin_refresh')]
          ])
        }
      ).catch(() => {});
    }
  }
});

// --- Serverless Entrypoint & Smart Cron Scheduler ---
module.exports = async (req, res) => {
  const startTime = Date.now();

  try {
    const db = await getDb();

    if (req.method === 'GET') {
      const cfg = await getConfig(db);

      if (cfg.is_active) {
        const { dateStr, curTotalMins } = getSLDateTime();
        const dailyLimit = Number(cfg.daily_limit) || 0;
        const todayPosted = cfg.today_date === dateStr ? (cfg.today_posted_count || 0) : 0;
        const remainingToday = Math.max(0, dailyLimit - todayPosted);

        const times = (cfg.schedule_times || []).sort();

        if (remainingToday > 0 && times.length > 0) {
          for (let i = 0; i < times.length; i++) {
            const t = times[i];
            const [tH, tM] = t.split(':').map(Number);
            const schedTotalMins = tH * 60 + tM;
            const slotKey = `${dateStr}_${t}`;

            if (
              curTotalMins >= schedTotalMins &&
              curTotalMins <= schedTotalMins + 20 &&
              cfg.last_posted_slot !== slotKey
            ) {
              const remainingSlots = times.length - i;
              const postsForThisSlot = Math.min(
                remainingToday,
                Math.max(1, Math.ceil(remainingToday / remainingSlots))
              );

              await db.collection('settings').updateOne(
                { _id: 'main_config' },
                {
                  $set: {
                    last_posted_slot: slotKey,
                    today_date: dateStr,
                    today_posted_count: todayPosted,
                    pending_batch_count: postsForThisSlot
                  }
                }
              );
              break;
            }
          }
        }

        await runScheduledBatch(db, startTime);
      }

      return res.status(200).json({ ok: true, status: 'cron_checked' });
    }

    if (req.method === 'POST' && req.body) {
      await bot.handleUpdate(req.body);
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(200).json({ ok: false });
  }
};
