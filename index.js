import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import OpenAI from "openai";
import { google } from 'googleapis';
import fs from 'fs';
import axios from 'axios';
import path from 'path';
import pg from 'pg';

const app = express();
app.use(bodyParser.json());

// --- VARIABLES DE ENTORNO ---
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

// --- CONFIGURACIÓN DE POSTGRESQL ---
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- CONFIGURACIÓN DE GOOGLE ---
const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
if (GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
}
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

// --- DEFINICIÓN DE HERRAMIENTAS ---
const tools = [
  { type: "function", function: { name: "get_calendar_events", description: "Obtiene eventos del calendario para un rango de fechas.", parameters: { type: "object", properties: { timeMin: { type: "string", description: "Fecha ISO de inicio." }, timeMax: { type: "string", description: "Fecha ISO de fin." } }, required: ["timeMin", "timeMax"] } } },
  { type: "function", function: { name: "create_calendar_event", description: "Crea un evento en el calendario.", parameters: { type: "object", properties: { summary: { type: "string" }, startDateTime: { type: "string" }, endDateTime: { type: "string" } }, required: ["summary", "startDateTime", "endDateTime"] } } },
  { type: "function", function: { name: "update_calendar_event", description: "Modifica un evento del calendario.", parameters: { type: "object", properties: { eventId: { type: "string" }, startDateTime: { type: "string" }, endDateTime: { type: "string" } }, required: ["eventId", "startDateTime", "endDateTime"] } } },
  { type: "function", function: { name: "save_user_fact", description: "Guarda un hecho permanente sobre el usuario (nombre, preferencias).", parameters: { type: "object", properties: { name: { type: "string" }, preferences: { type: "string" } } } } },
  { type: "function", function: { name: "get_user_fact", description: "Recupera un hecho guardado del usuario.", parameters: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] } } },
  { type: "function", function: { name: "search_emails", description: "Busca correos en Gmail basados en una consulta.", parameters: { type: "object", properties: { query: { type: "string", description: "Consulta de búsqueda de Gmail (ej: 'from:test@test.com is:unread')." } }, required: ["query"] } } },
  { type: "function", function: { name: "get_email_details", description: "Obtiene el contenido completo de un correo usando su ID.", parameters: { type: "object", properties: { messageId: { type: "string", description: "El ID del correo a leer." } }, required: ["messageId"] } } },
  { type: "function", function: { name: "send_email", description: "Envía un correo directamente. Usar con precaución. Es preferible crear un borrador.", parameters: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"] } } },
  { type: "function", function: { name: "create_draft", description: "Crea un borrador de correo en Gmail para que el usuario lo revise antes de enviar.", parameters: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"] } } },
  { type: "function", function: { name: "modify_email_status", description: "Modifica el estado de un correo (archivar, borrar, marcar como leído/no leído).", parameters: { type: "object", properties: { messageId: { type: "string", description: "El ID del correo a modificar." }, action: { type: "string", enum: ["archive", "trash", "mark_as_read", "mark_as_unread"], description: "La acción a realizar." } }, required: ["messageId", "action"] } } },
];

// --- FUNCIONES DE HERRAMIENTAS ---
async function getCalendarEvents(timeMin, timeMax) { if (!timeMin || !timeMax) { return []; } try { const list = await calendar.calendarList.list(); const eventPromises = list.data.items.map(cal => calendar.events.list({ calendarId: cal.id, timeMin, timeMax, maxResults: 50, singleEvents: true, orderBy: 'startTime' })); const responses = await Promise.all(eventPromises); let allEvents = []; responses.forEach(res => { if (res.data.items) { allEvents = allEvents.concat(res.data.items); } }); allEvents.sort((a, b) => new Date(a.start.dateTime || a.start.date) - new Date(b.start.dateTime || b.start.date)); return allEvents.slice(0, 25); } catch (e) { console.error("Error en getCalendarEvents:", e); return { error: "No se pudieron obtener los eventos." }; } }
async function createCalendarEvent(summary, startDateTime, endDateTime) { try { const res = await calendar.events.insert({ calendarId: 'primary', requestBody: { summary, start: { dateTime: startDateTime, timeZone: 'Europe/Madrid' }, end: { dateTime: endDateTime, timeZone: 'Europe/Madrid' } } }); return res.data; } catch (e) { console.error("Error en createCalendarEvent:", e); return { error: "No se pudo crear el evento." }; } }
async function updateCalendarEvent(eventId, startDateTime, endDateTime) { try { const res = await calendar.events.patch({ calendarId: 'primary', eventId, requestBody: { start: { dateTime: startDateTime, timeZone: 'Europe/Madrid' }, end: { dateTime: endDateTime, timeZone: 'Europe/Madrid' } } }); return res.data; } catch (e) { console.error(`Error en updateCalendarEvent ${eventId}:`, e); return { error: "No se pudo actualizar el evento." }; } }
async function saveUserFact(userId, { name, preferences }) { try { const query = `INSERT INTO user_profiles (user_id, name, preferences, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_id) DO UPDATE SET name = COALESCE(EXCLUDED.name, user_profiles.name), preferences = COALESCE(EXCLUDED.preferences, user_profiles.preferences), updated_at = NOW();`; await pool.query(query, [userId, name, preferences]); return { status: "success", message: "Hecho guardado." }; } catch (e) { console.error("Error en saveUserFact:", e); return { status: "error", message: "No se pudo guardar la info." }; } }
async function getUserFact(userId, { fact }) { try { const res = await pool.query(`SELECT ${fact} FROM user_profiles WHERE user_id = $1`, [userId]); if (res.rows.length > 0) return res.rows[0]; return { status: "not_found" }; } catch (e) { console.error("Error en getUserFact:", e); return { status: "error" }; } }
async function searchEmails({ query }) { try { const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 50 }); const msgs = res.data.messages || []; if (msgs.length === 0) return { status: "success", emails: [] }; const promises = msgs.map(async (m) => { const d = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['Subject', 'From'] }); const h = d.data.payload.headers; return { id: m.id, from: h.find(hd => hd.name === 'From')?.value, subject: h.find(hd => hd.name === 'Subject')?.value, snippet: d.data.snippet }; }); return { status: "success", emails: await Promise.all(promises) }; } catch (e) { console.error("Error en searchEmails:", e); return { status: "error", message: "No se pudo buscar." }; } }
async function getEmailDetails({ messageId }) { try { const res = await gmail.users.messages.get({ userId: 'me', id: messageId }); let body = ''; const p = res.data.payload; if (p.parts) { const part = p.parts.find(pt => pt.mimeType === 'text/plain'); if (part && part.body.data) body = Buffer.from(part.body.data, 'base64').toString('utf-8'); } else if (p.body.data) body = Buffer.from(p.body.data, 'base64').toString('utf-8'); return { status: "success", id: messageId, from: p.headers.find(h => h.name === 'From')?.value, subject: p.headers.find(h => h.name === 'Subject')?.value, body: body.substring(0, 4000) }; } catch (e) { console.error("Error en getEmailDetails:", e); return { status: "error" }; } }
async function sendEmail({ to, subject, body }) { try { const raw = [`To: ${to}`,`Subject: ${subject}`,'Content-Type: text/plain; charset=utf-8','',body].join('\n'); const enc = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw: enc } }); return { status: "success", messageId: res.data.id }; } catch (e) { console.error("Error en sendEmail:", e); return { status: "error" }; } }
async function createDraft({ to, subject, body }) { try { const raw = [`To: ${to}`,`Subject: ${subject}`,'Content-Type: text/plain; charset=utf-8','',body].join('\n'); const enc = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); const res = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw: enc } } }); return { status: "success", draftId: res.data.id }; } catch (e) { console.error("Error en createDraft:", e); return { status: "error" }; } }
async function modifyEmailStatus({ messageId, action }) { try { let reqBody = {}; if (action === 'archive') reqBody = { removeLabelIds: ['INBOX'] }; else if (action === 'trash') { await gmail.users.messages.trash({ userId: 'me', id: messageId }); return { status: "success" }; } else if (action === 'mark_as_read') reqBody = { removeLabelIds: ['UNREAD'] }; else if (action === 'mark_as_unread') reqBody = { addLabelIds: ['UNREAD'] }; await gmail.users.messages.modify({ userId: 'me', id: messageId, requestBody: reqBody }); return { status: "success" }; } catch (e) { console.error(`Error en modifyEmailStatus (${action}):`, e); return { status: "error" }; } }
async function transcribeAudio(mediaId) { try { const mediaUrlResponse = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } }); const mediaUrl = mediaUrlResponse.data.url; const audioResponse = await axios({ url: mediaUrl, method: 'GET', responseType: 'stream', headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } }); const tempPath = path.join('/tmp', `${mediaId}.ogg`); const writer = fs.createWriteStream(tempPath); audioResponse.data.pipe(writer); await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); }); const transcription = await openai.audio.transcriptions.create({ file: fs.createReadStream(tempPath), model: "whisper-1" }); fs.unlinkSync(tempPath); return transcription.text; } catch (error) { console.error("Error al transcribir el audio:", error.response ? error.response.data : error.message); return { error: "No se pudo procesar el audio." }; } }

// --- FUNCIÓN PRINCIPAL DE PROCESAMIENTO (EL CEREBRO) ---
async function procesarTextoConIA(texto, from) {
    try {
        const userKey = from;
        let userProfile = {};
        try { const res = await pool.query('SELECT name, preferences FROM user_profiles WHERE user_id = $1', [userKey]); if (res.rows.length > 0) userProfile = res.rows[0]; } catch (e) { console.error("Error al cargar perfil:", e); }
        let conversationHistory = [];
        try { const res = await pool.query(`SELECT role, content FROM messages WHERE user_id = $1 ORDER BY timestamp DESC LIMIT 10`, [userKey]); conversationHistory = res.rows.reverse(); } catch (e) { console.error("Error al cargar historial:", e); }
        
        const systemMessage = { role: "system", content: `Eres Oráculo, un asistente de IA proactivo. La fecha actual es ${new Date().toISOString()}. Capacidades de Gmail: Prefiere SIEMPRE 'create_draft' para crear borradores. Solo usa 'send_email' si el usuario insiste. Puedes buscar ('search_emails'), leer ('get_email_details'), y gestionar ('modify_email_status' para archivar, borrar, marcar leído/no leído). Sabes esto sobre el usuario: Nombre: ${userProfile.name || 'desconocido'}. Si te da nueva info, usa 'save_user_fact'. Sé conciso.` };
        const messages = [ systemMessage, ...conversationHistory, { role: "user", content: texto } ];

        let maxTurns = 5;
        while (maxTurns-- > 0) {
            const response = await openai.chat.completions.create({ model: "gpt-4o", messages: messages, tools: tools, tool_choice: "auto" });
            const responseMessage = response.choices[0].message;
            messages.push(responseMessage);
            
            if (responseMessage.tool_calls) {
                for (const toolCall of responseMessage.tool_calls) {
                    const functionName = toolCall.function.name;
                    const functionArgs = JSON.parse(toolCall.function.arguments);
                    let functionResponse;

                    if (functionName === "get_calendar_events") functionResponse = await getCalendarEvents(functionArgs.timeMin, functionArgs.timeMax);
                    else if (functionName === "create_calendar_event") functionResponse = await createCalendarEvent(functionArgs.summary, functionArgs.startDateTime, functionArgs.endDateTime);
                    else if (functionName === "update_calendar_event") functionResponse = await updateCalendarEvent(functionArgs.eventId, functionArgs.startDateTime, functionArgs.endDateTime);
                    else if (functionName === "save_user_fact") functionResponse = await saveUserFact(userKey, functionArgs);
                    else if (functionName === "get_user_fact") functionResponse = await getUserFact(userKey, functionArgs);
                    else if (functionName === "search_emails") functionResponse = await searchEmails(functionArgs);
                    else if (functionName === "get_email_details") functionResponse = await getEmailDetails(functionArgs);
                    else if (functionName === "send_email") functionResponse = await sendEmail(functionArgs);
                    else if (functionName === "create_draft") functionResponse = await createDraft(functionArgs);
                    else if (functionName === "modify_email_status") functionResponse = await modifyEmailStatus(functionArgs);
                    
                    let contentObject = functionResponse;
                    if (functionName === 'get_calendar_events' && Array.isArray(functionResponse)) {
                        contentObject = functionResponse.map(e => ({ id: e.id, summary: e.summary, start: e.start.dateTime, end: e.end.dateTime }));
                    }
                    messages.push({ tool_call_id: toolCall.id, role: "tool", name: functionName, content: JSON.stringify(contentObject) || 'null' });
                }
            } else {
                const finalMessage = responseMessage.content;
                try {
                    await pool.query(`INSERT INTO messages (user_id, role, content) VALUES ($1, $2, $3)`, [userKey, 'user', texto]);
                    await pool.query(`INSERT INTO messages (user_id, role, content) VALUES ($1, $2, $3)`, [userKey, 'assistant', finalMessage]);
                } catch (e) { console.error("Error al guardar en PostgreSQL:", e); }
                await enviarMensajeWhatsapp(finalMessage, from);
                return;
            }
        }
    } catch (error) {
        console.error("🚨 ERROR FATAL DENTRO DE procesarTextoConIA:", error);
        await enviarMensajeWhatsapp("Lo siento, he tenido un problema interno al procesar tu solicitud.", from);
    }
}

// --- FUNCIÓN AUXILIAR DE ENVÍO ---
async function enviarMensajeWhatsapp(texto, numeroDestinatario) {
    try {
        const response = await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${WHATSAPP_TOKEN}` },
            body: JSON.stringify({ messaging_product: "whatsapp", to: numeroDestinatario, text: { body: texto } }),
        });
        const responseData = await response.json();
        console.log("✅ Respuesta de la API de Meta:", JSON.stringify(responseData, null, 2));
    } catch (error) {
        console.error("❌ Error al enviar mensaje a WhatsApp:", error);
    }
}

// --- ENDPOINTS Y SERVIDOR ---
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode && token === VERIFY_TOKEN) { res.status(200).send(challenge); } else { res.sendStatus(403); }
});

app.post("/webhook", async (req, res) => {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!entry) return res.sendStatus(200);
    const from = entry.from;
    let userText;
    try {
        if (entry.text) {
            userText = entry.text.body;
            console.log("Mensaje de texto recibido:", userText);
        } else if (entry.audio) {
            console.log("Mensaje de audio recibido. Transcribiendo...");
            const transcriptionResult = await transcribeAudio(entry.audio.id);
            if (transcriptionResult.error) {
                await enviarMensajeWhatsapp("Lo siento, no pude entender tu audio.", from);
                return res.sendStatus(200);
            }
            userText = transcriptionResult;
            await enviarMensajeWhatsapp(`He entendido: "${userText}"`, from);
        }

        if (userText) {
            if (userText.toLowerCase() === "/conectar_google") {
                const SCOPES = ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'];
                const authUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
                await enviarMensajeWhatsapp(`Para autorizar el acceso a Google Calendar y Gmail, haz clic aquí:\n\n${authUrl}`, from);
            } else {
                await procesarTextoConIA(userText, from);
            }
        }
    } catch (error) {
        console.error("Error fatal en el webhook:", error);
        await enviarMensajeWhatsapp("Uups, algo salió muy mal. Por favor, inténtalo de nuevo.", from);
    }
    res.sendStatus(200);
});

app.get('/oauth2callback', async (req, res) => {
    const code = req.query.code;
    try {
        const { tokens } = await oauth2Client.getToken(code);
        const refreshToken = tokens.refresh_token;
        console.log("--- ¡NUEVO REFRESH TOKEN OBTENIDO! ---");
        console.log("Copia este token y actualiza la variable de entorno GOOGLE_REFRESH_TOKEN en Railway:");
        console.log(refreshToken);
        console.log("---------------------------------");
        res.send('¡Autorización completada! Guarda el nuevo Refresh Token que apareció en los logs de Railway.');
    } catch (error) {
        console.error("Error al obtener tokens de Google:", error);
        res.status(500).send('Hubo un error durante la autorización.');
    }
});

// --- FUNCIÓN DE INICIALIZACIÓN DE DB Y SERVIDOR ---
async function initializeDatabase() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, user_id VARCHAR(255) NOT NULL, role VARCHAR(50) NOT NULL, content TEXT NOT NULL, timestamp TIMESTAMPTZ DEFAULT NOW());`);
        await pool.query(`CREATE TABLE IF NOT EXISTS user_profiles (user_id VARCHAR(255) PRIMARY KEY, name VARCHAR(255), preferences TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());`);
        console.log("✅ Tablas de la base de datos verificadas o creadas.");
    } catch (error) {
        console.error("❌ Error al inicializar la base de datos:", error);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initializeDatabase();
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});