const { Telegraf, Markup } = require('telegraf');
const { MongoClient, ObjectId } = require('mongodb');
const sharp = require('sharp');

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
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000
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

// --- Pure Raw RGBA Pixel Helpers (Zero SVG / Zero librsvg) ---
function createRoundedMaskRaw(w, h, r) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let alpha = 255;
      let dx = 0;
      let dy = 0;
      if (x < r && y < r) {
        dx = r - x;
        dy = r - y;
      } else if (x >= w - r && y < r) {
        dx = x - (w - r - 1);
        dy = r - y;
      } else if (x < r && y >= h - r) {
        dx = r - x;
        dy = y - (h - r - 1);
      } else if (x >= w - r && y >= h - r) {
        dx = x - (w - r - 1);
        dy = y - (h - r - 1);
      }
      if (dx > 0 || dy > 0) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > r + 0.5) alpha = 0;
        else if (dist > r - 0.5) alpha = Math.round((r + 0.5 - dist) * 255);
      }
      const idx = (y * w + x) * 4;
      buf[idx] = 255;
      buf[idx + 1] = 255;
      buf[idx + 2] = 255;
      buf[idx + 3] = alpha;
    }
  }
  return buf;
}

function createGlassBorderRaw(canvasW, canvasH, padX, padY, innerW, innerH, r) {
  const buf = Buffer.alloc(canvasW * canvasH * 4);
  const stroke = 2.5;
  for (let y = padY; y < padY + innerH; y++) {
    const iy = y - padY;
    for (let x = padX; x < padX + innerW; x++) {
      const ix = x - padX;
      let distFromEdge = Math.min(ix, innerW - 1 - ix, iy, innerH - 1 - iy);

      let dx = 0;
      let dy = 0;
      if (ix < r && iy < r) {
        dx = r - ix;
        dy = r - iy;
      } else if (ix >= innerW - r && iy < r) {
        dx = ix - (innerW - r - 1);
        dy = r - iy;
      } else if (ix < r && iy >= innerH - r) {
        dx = r - ix;
        dy = iy - (innerH - r - 1);
      } else if (ix >= innerW - r && iy >= innerH - r) {
        dx = ix - (innerW - r - 1);
        dy = iy - (innerH - r - 1);
      }
      if (dx > 0 || dy > 0) {
        distFromEdge = r - Math.sqrt(dx * dx + dy * dy);
      }

      if (distFromEdge >= 0 && distFromEdge <= stroke) {
        const idx = (y * canvasW + x) * 4;
        buf[idx] = 255;
        buf[idx + 1] = 255;
        buf[idx + 2] = 255;
        buf[idx + 3] = 75;
      }
    }
  }
  return buf;
}

function drawCapsule(buf, w, h, x1, y1, x2, y2, radius, alpha) {
  const minX = Math.max(0, Math.floor(Math.min(x1, x2) - radius - 2));
  const maxX = Math.min(w - 1, Math.ceil(Math.max(x1, x2) + radius + 2));
  const minY = Math.max(0, Math.floor(Math.min(y1, y2) - radius - 2));
  const maxY = Math.min(h - 1, Math.ceil(Math.max(y1, y2) + radius + 2));
  const vx = x2 - x1;
  const vy = y2 - y1;
  const lenSq = vx * vx + vy * vy;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let t = lenSq === 0 ? 0 : ((x - x1) * vx + (y - y1) * vy) / lenSq;
      t = Math.max(0, Math.min(1, t));
      const px = x1 + t * vx;
      const py = y1 + t * vy;
      const dist = Math.sqrt((x - px) * (x - px) + (y - py) * (y - py));
      if (dist <= radius + 0.8) {
        const cov = dist <= radius - 0.8 ? 1 : (radius + 0.8 - dist) / 1.6;
        const a = Math.round(alpha * cov);
        const idx = (y * w + x) * 4;
        if (a > buf[idx + 3]) {
          buf[idx] = 255;
          buf[idx + 1] = 255;
          buf[idx + 2] = 255;
          buf[idx + 3] = a;
        }
      }
    }
  }
}

function drawRing(buf, w, h, cx, cy, rx, ry, thickness, alpha) {
  const minX = Math.max(0, Math.floor(cx - rx - thickness - 2));
  const maxX = Math.min(w - 1, Math.ceil(cx + rx + thickness + 2));
  const minY = Math.max(0, Math.floor(cy - ry - thickness - 2));
  const maxY = Math.min(h - 1, Math.ceil(cy + ry + thickness + 2));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const d = Math.sqrt(nx * nx + ny * ny);
      const approxDist = Math.abs(d - 1) * ((rx + ry) * 0.5);
      if (approxDist <= thickness + 0.8) {
        const cov = approxDist <= thickness - 0.8 ? 1 : (thickness + 0.8 - approxDist) / 1.6;
        const a = Math.round(alpha * cov);
        const idx = (y * w + x) * 4;
        if (a > buf[idx + 3]) {
          buf[idx] = 255;
          buf[idx + 1] = 255;
          buf[idx + 2] = 255;
          buf[idx + 3] = a;
        }
      }
    }
  }
}

function createHotLankaWatermarkRaw(w, h) {
  const buf = Buffer.alloc(w * h * 4);
  const targetW = w * 0.72;
  const s = targetW / 630;
  const ox = (w - targetW) / 2;
  const oy = (h - 110 * s) / 2;
  const r = Math.max(2, 6.2 * s);
  const alpha = 82; // ~32% subtle opacity

  const line = (x1, y1, x2, y2) =>
    drawCapsule(buf, w, h, ox + x1 * s, oy + y1 * s, ox + x2 * s, oy + y2 * s, r, alpha);
  const ring = (cx, cy, rx, ry) =>
    drawRing(buf, w, h, ox + cx * s, oy + cy * s, rx * s, ry * s, r, alpha);

  // H
  line(15, 15, 15, 95);
  line(15, 55, 62, 55);
  line(62, 15, 62, 95);
  // o
  ring(112, 70, 24, 25);
  // t
  line(170, 22, 170, 88);
  line(170, 88, 186, 95);
  line(154, 45, 188, 45);
  // L
  line(255, 15, 255, 95);
  line(255, 95, 305, 95);
  // a
  ring(348, 71, 22, 24);
  line(370, 47, 370, 95);
  // n
  line(404, 47, 404, 95);
  line(404, 58, 422, 47);
  line(422, 47, 442, 56);
  line(442, 56, 442, 95);
  // k
  line(476, 15, 476, 95);
  line(518, 47, 476, 73);
  line(492, 63, 522, 95);
  // a
  ring(568, 71, 22, 24);
  line(590, 47, 590, 95);

  return buf;
}

// --- Ultra-Fast Image Processing (< 0.3s, Zero SVG) ---
async function processImageWithEffects(fileId, cfg) {
  const fileLink = await bot.telegram.getFileLink(fileId);
  const response = await fetch(fileLink.href);
  if (!response.ok) throw new Error('FILE_UNAVAILABLE');
  const inputBuffer = Buffer.from(await response.arrayBuffer());

  if (!cfg.blur_frame && !cfg.watermark_enabled) {
    return inputBuffer;
  }

  const normalizedBuffer = await sharp(inputBuffer)
    .resize({ width: 900, withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();

  const metadata = await sharp(normalizedBuffer).metadata();
  const origW = metadata.width || 720;
  const origH = metadata.height || 1280;

  let foregroundBuffer = normalizedBuffer;

  // 1. Apply Subtle Centered Watermark
  if (cfg.watermark_enabled) {
    const wmRaw = createHotLankaWatermarkRaw(origW, origH);
    foregroundBuffer = await sharp(normalizedBuffer)
      .composite([
        {
          input: wmRaw,
          raw: { width: origW, height: origH, channels: 4 },
          left: 0,
          top: 0
        }
      ])
      .toBuffer();
  }

  if (!cfg.blur_frame) {
    return foregroundBuffer;
  }

  // 2. Apply Dynamic Glassmorphism Blurred Frame
  const padX = Math.round(origW * 0.11);
  const padY = Math.round(origH * 0.08);
  const canvasW = origW + padX * 2;
  const canvasH = origH + padY * 2;
  const cornerRadius = Math.max(16, Math.round(origW * 0.035));

  const smallBlur = await sharp(normalizedBuffer)
    .resize(200, Math.max(200, Math.round((200 * canvasH) / canvasW)), { fit: 'cover' })
    .blur(10)
    .modulate({ brightness: 0.65 })
    .toBuffer();

  const blurredBg = await sharp(smallBlur)
    .resize(canvasW, canvasH, { fit: 'fill' })
    .toBuffer();

  const maskRaw = createRoundedMaskRaw(origW, origH, cornerRadius);
  const roundedForeground = await sharp(foregroundBuffer)
    .ensureAlpha()
    .composite([
      {
        input: maskRaw,
        raw: { width: origW, height: origH, channels: 4 },
        blend: 'dest-in'
      }
    ])
    .png()
    .toBuffer();

  const borderRaw = createGlassBorderRaw(canvasW, canvasH, padX, padY, origW, origH, cornerRadius);

  return await sharp(blurredBg)
    .composite([
      { input: roundedForeground, left: padX, top: padY },
      {
        input: borderRaw,
        raw: { width: canvasW, height: canvasH, channels: 4 },
        left: 0,
        top: 0
      }
    ])
    .jpeg({ quality: 88 })
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
      console.error('Publish Error:', err.message);
      if (
        err.message &&
        (err.message.includes('FILE_UNAVAILABLE') ||
          err.message.includes('wrong file_id') ||
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
        return { status: 'error' };
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
    await ctx.reply('📭 Queue is empty! Send some screenshots first.').catch(() => {});
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
  cfg.blur_frame = !cfg.blur_frame;
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
  cfg.watermark_enabled = !cfg.watermark_enabled;
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
    console.error('Handler Error:', err.message);
    return res.status(200).json({ ok: false });
  }
};
