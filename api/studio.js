const crypto = require('crypto');
const { Telegraf, Markup } = require('telegraf');
const { MongoClient, ObjectId } = require('mongodb');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const STUDIO_PIN = process.env.STUDIO_PIN || '1234';

const bot = new Telegraf(BOT_TOKEN);

let cachedDb = null;
let clientPromise = null;

async function getDb() {
  if (cachedDb) return cachedDb;
  if (!clientPromise) {
    const client = new MongoClient(MONGODB_URI, { maxPoolSize: 10 });
    clientPromise = client.connect();
  }
  const client = await clientPromise;
  cachedDb = client.db('vip_promo_db');
  return cachedDb;
}

// Sri Lanka Time Formatter (UTC +5:30) -> "YYYY-MM-DD HH:MM"
function getSLNowString() {
  const slDate = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const yyyy = slDate.getUTCFullYear();
  const mm = String(slDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(slDate.getUTCDate()).padStart(2, '0');
  const hh = String(slDate.getUTCHours()).padStart(2, '0');
  const min = String(slDate.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function verifyTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculatedHash !== hash) return null;
    const userObj = JSON.parse(params.get('user') || '{}');
    return userObj.id === ADMIN_ID ? userObj : null;
  } catch (e) {
    return null;
  }
}

function isAuthorized(req) {
  const tgInitData = req.headers['x-tg-init-data'];
  if (tgInitData) {
    return Boolean(verifyTelegramInitData(tgInitData));
  }
  const pin = req.headers['x-admin-pin'];
  return Boolean(pin && pin === STUDIO_PIN);
}

function buildInlineKeyboard(buttons) {
  if (!Array.isArray(buttons) || buttons.length === 0) return undefined;
  const rows = [];
  let halfBuffer = [];

  for (const b of buttons) {
    if (!b.text || !b.url) continue;
    const btnObj = Markup.button.url(b.text, b.url);
    if (b.layout === 'half') {
      halfBuffer.push(btnObj);
      if (halfBuffer.length === 2) {
        rows.push(halfBuffer);
        halfBuffer = [];
      }
    } else {
      if (halfBuffer.length > 0) {
        rows.push(halfBuffer);
        halfBuffer = [];
      }
      rows.push([btnObj]);
    }
  }
  if (halfBuffer.length > 0) rows.push(halfBuffer);
  return rows.length > 0 ? Markup.inlineKeyboard(rows) : undefined;
}

async function sendToSingleChannel(chatId, post) {
  const kb = buildInlineKeyboard(post.buttons);
  const extra = {
    parse_mode: 'HTML',
    disable_notification: Boolean(post.silent),
    protect_content: Boolean(post.protect),
    ...(kb || {})
  };

  let sentMsg;
  if (post.media && post.media.dataUrl) {
    const base64Data = post.media.dataUrl.split(',')[1];
    const buffer = Buffer.from(base64Data, 'base64');
    const source = { source: buffer, filename: post.media.name || 'media' };

    if (post.media.type === 'video') {
      sentMsg = await bot.telegram.sendVideo(chatId, source, {
        caption: post.text || '',
        supports_streaming: true,
        ...extra
      });
    } else {
      sentMsg = await bot.telegram.sendPhoto(chatId, source, {
        caption: post.text || '',
        ...extra
      });
    }
  } else {
    sentMsg = await bot.telegram.sendMessage(chatId, post.text, {
      disable_web_page_preview: false,
      ...extra
    });
  }

  if (post.pin && sentMsg?.message_id) {
    await bot.telegram.pinChatMessage(chatId, sentMsg.message_id, { disable_notification: true }).catch(() => {});
  }

  return sentMsg?.message_id;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const db = await getDb();
  const body = req.body || {};
  const { action } = body;

  try {
    if (action === 'get_state') {
      const me = await bot.telegram.getMe().catch(() => ({ username: '' }));
      const rawChannels = await db.collection('studio_channels').find({}).sort({ added_at: -1 }).toArray();

      const channels = await Promise.all(
        rawChannels.map(async (ch) => {
          try {
            const [chatInfo, freshCount] = await Promise.all([
              bot.telegram.getChat(ch.chat_id),
              bot.telegram.getChatMembersCount(ch.chat_id)
            ]);
            const updatedTitle = chatInfo.title || ch.title;
            const updatedUsername = chatInfo.username || ch.username || '';

            if (freshCount !== ch.members_count || updatedTitle !== ch.title) {
              await db.collection('studio_channels').updateOne(
                { _id: ch._id },
                { $set: { title: updatedTitle, username: updatedUsername, members_count: freshCount } }
              );
            }
            return { ...ch, title: updatedTitle, username: updatedUsername, members_count: freshCount };
          } catch (e) {
            return ch;
          }
        })
      );

      const posts = await db.collection('studio_posts').find({}).sort({ _id: -1 }).limit(50).toArray();
      const presets = await db.collection('studio_presets').find({}).sort({ _id: -1 }).toArray();

      return res.status(200).json({
        ok: true,
        botUsername: me.username || '',
        channels,
        posts,
        presets
      });
    }

    // Provides authorized admin session with Bot Token for Direct Browser->Telegram Media Upload
    if (action === 'get_upload_token') {
      return res.status(200).json({ ok: true, token: BOT_TOKEN });
    }

    // Records already-published Direct Media Post into MongoDB history
    if (action === 'record_published') {
      const channelIds = (body.channel_ids || []).map(String);
      const channels = await db.collection('studio_channels').find({
        chat_id: { $in: channelIds }
      }).toArray();
      const channelTitles = channels.map(c => c.title);

      const deleteAt = Number(body.auto_delete_hours || 0) > 0
        ? new Date(Date.now() + Number(body.auto_delete_hours) * 3600 * 1000)
        : null;

      await db.collection('studio_posts').insertOne({
        status: 'published',
        channel_ids: channelIds,
        channel_titles: channelTitles,
        sent_messages: body.sent_messages || [],
        text: body.text || '',
        has_media: Boolean(body.has_media),
        buttons: body.buttons || [],
        delete_at: deleteAt,
        created_at: getSLNowString()
      });

      return res.status(200).json({ ok: true });
    }

    if (action === 'send_picker') {
      const adminRights = {
        is_anonymous: false,
        can_manage_chat: true,
        can_delete_messages: true,
        can_manage_video_chats: false,
        can_restrict_members: false,
        can_promote_members: false,
        can_change_info: false,
        can_invite_users: false,
        can_post_messages: true,
        can_edit_messages: true
      };

      await bot.telegram.sendMessage(
        ADMIN_ID,
        '📢 Tap the button below to pick a channel:',
        {
          reply_markup: {
            keyboard: [
              [
                {
                  text: '➕ Pick Channel',
                  request_chat: {
                    request_id: 101,
                    chat_is_channel: true,
                    user_administrator_rights: adminRights,
                    bot_administrator_rights: adminRights
                  }
                }
              ],
              [{ text: '❌ Cancel Picker' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        }
      );
      return res.status(200).json({ ok: true });
    }

    if (action === 'add_channel') {
      const ref = String(body.channel_ref || '').trim();
      const chat = await bot.telegram.getChat(ref);
      const members = await bot.telegram.getChatMembersCount(chat.id).catch(() => 0);

      await db.collection('studio_channels').updateOne(
        { chat_id: String(chat.id) },
        {
          $set: {
            chat_id: String(chat.id),
            title: chat.title || ref,
            username: chat.username || '',
            members_count: members,
            added_at: new Date()
          }
        },
        { upsert: true }
      );
      return res.status(200).json({ ok: true });
    }

    if (action === 'remove_channel') {
      await db.collection('studio_channels').deleteOne({ chat_id: String(body.chat_id) });
      return res.status(200).json({ ok: true });
    }

    if (action === 'save_preset') {
      await db.collection('studio_presets').insertOne({
        text: body.text,
        url: body.url,
        layout: body.layout || 'full'
      });
      return res.status(200).json({ ok: true });
    }

    if (action === 'delete_preset') {
      await db.collection('studio_presets').deleteOne({ _id: new ObjectId(body.id) });
      return res.status(200).json({ ok: true });
    }

    if (action === 'save_draft') {
      const channels = await db.collection('studio_channels').find({
        chat_id: { $in: (body.channel_ids || []).map(String) }
      }).toArray();

      await db.collection('studio_posts').insertOne({
        status: 'draft',
        channel_ids: (body.channel_ids || []).map(String),
        channel_titles: channels.map(c => c.title),
        text: body.text || '',
        buttons: body.buttons || [],
        auto_delete_hours: Number(body.auto_delete_hours || 0),
        silent: Boolean(body.silent),
        pin: Boolean(body.pin),
        protect: Boolean(body.protect),
        created_at: getSLNowString()
      });
      return res.status(200).json({ ok: true });
    }

    if (action === 'publish_post') {
      const channelIds = (body.channel_ids || []).map(String);
      const channels = await db.collection('studio_channels').find({
        chat_id: { $in: channelIds }
      }).toArray();
      const channelTitles = channels.map(c => c.title);

      if (body.publish_mode === 'schedule') {
        await db.collection('studio_posts').insertOne({
          status: 'scheduled',
          channel_ids: channelIds,
          channel_titles: channelTitles,
          text: body.text || '',
          media: body.media || null,
          buttons: body.buttons || [],
          schedule_time: body.schedule_time,
          repeat_mode: body.repeat_mode || 'none',
          auto_delete_hours: Number(body.auto_delete_hours || 0),
          silent: Boolean(body.silent),
          pin: Boolean(body.pin),
          protect: Boolean(body.protect),
          created_at: getSLNowString()
        });
        return res.status(200).json({ ok: true });
      }

      const sentMessages = [];
      for (const cid of channelIds) {
        const msgId = await sendToSingleChannel(cid, body);
        if (msgId) sentMessages.push({ chat_id: cid, message_id: msgId });
      }

      const deleteAt = Number(body.auto_delete_hours || 0) > 0
        ? new Date(Date.now() + Number(body.auto_delete_hours) * 3600 * 1000)
        : null;

      await db.collection('studio_posts').insertOne({
        status: 'published',
        channel_ids: channelIds,
        channel_titles: channelTitles,
        sent_messages: sentMessages,
        text: body.text || '',
        has_media: Boolean(body.media),
        buttons: body.buttons || [],
        delete_at: deleteAt,
        created_at: getSLNowString()
      });

      return res.status(200).json({ ok: true });
    }

    if (action === 'edit_published') {
      const post = await db.collection('studio_posts').findOne({ _id: new ObjectId(body.id) });
      if (!post) return res.status(404).json({ ok: false, error: 'Post not found' });

      const kb = buildInlineKeyboard(post.buttons);
      for (const m of post.sent_messages || []) {
        if (post.has_media) {
          await bot.telegram.editMessageCaption(m.chat_id, m.message_id, undefined, body.text, {
            parse_mode: 'HTML',
            ...(kb || {})
          }).catch(() => {});
        } else {
          await bot.telegram.editMessageText(m.chat_id, m.message_id, undefined, body.text, {
            parse_mode: 'HTML',
            ...(kb || {})
          }).catch(() => {});
        }
      }

      await db.collection('studio_posts').updateOne(
        { _id: post._id },
        { $set: { text: body.text } }
      );
      return res.status(200).json({ ok: true });
    }

    if (action === 'delete_post') {
      const post = await db.collection('studio_posts').findOne({ _id: new ObjectId(body.id) });
      if (post && body.delete_from_telegram) {
        for (const m of post.sent_messages || []) {
          await bot.telegram.deleteMessage(m.chat_id, m.message_id).catch(() => {});
        }
      }
      await db.collection('studio_posts').deleteOne({ _id: new ObjectId(body.id) });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
};
