import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import OpenAI from "openai";
import { google } from 'googleapis';
import fs from 'fs';
import axios from 'axios';
import path from 'path';
import pg from 'pg'; // <--- AÑADIDO: El "driver" para PostgreSQL

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
const DATABASE_URL = process.env.DATABASE_URL; // <--- AÑADIDO: Railway lo inyecta solo

// --- CONFIGURACIÓN DE POSTGRESQL ---
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Requerido para conexiones seguras a Railway
  }
});

// --- CONFIGURACIÓN DE GOOGLE ---
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

if (GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
}
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// --- DEFINICIÓN DE HERRAMIENTAS PARA OPENAI (sin cambios) ---
const tools = [ /* ... tu array de herramientas ... */ ];

// --- FUNCIONES DE HERRAMIENTAS (sin cambios) ---
async function getCalendarEvents(timeMin, timeMax) { /* ... tu código ... */ }
async function createCalendarEvent(summary, startDateTime, endDateTime) { /* ... tu código ... */ }
async function updateCalendarEvent(eventId, startDateTime, endDateTime) { /* ... tu código ... */ }
async function transcribeAudio(mediaId) { /* ... tu código ... */ }

// --- FUNCIÓN PRINCIPAL DE PROCESAMIENTO (MODIFICADA PARA USAR POSTGRESQL) ---
async function procesarTextoConIA(texto, from) {
    console.log("🧠 1. Iniciando procesamiento con IA...");
    const currentDate = new Date().toISOString();
    const userKey = from; // Usamos el número de WhatsApp como ID

    // --- CARGAR MEMORIA DESDE POSTGRESQL ---
    let conversationHistory = [];
    try {
        const historyResult = await pool.query(
            `SELECT role, content FROM messages WHERE user_id = $1 ORDER BY timestamp DESC LIMIT 10`,
            [userKey]
        );
        conversationHistory = historyResult.rows.reverse(); // Invertir para orden cronológico
        console.log("✅ Memoria de la conversación cargada desde PostgreSQL.");
    } catch (e) { console.error("Error al cargar historial de PostgreSQL:", e); }
    
    const systemMessage = { 
        role: "system", 
        content: `Eres un asistente de WhatsApp llamado Oráculo. La fecha y hora actual es ${currentDate}. [...]` // Tu prompt de sistema completo
    };

    const messages = [
        systemMessage,
        ...conversationHistory,
        { role: "user", content: texto }
    ];

    let maxTurns = 5;
    while (maxTurns > 0) {
        maxTurns--;

        const response = await openai.chat.completions.create({
            model: "gpt-4o", messages: messages, tools: tools, tool_choice: "auto",
        });
        
        const responseMessage = response.choices[0].message;
        messages.push(responseMessage);
        
        const toolCalls = responseMessage.tool_calls;
        if (toolCalls) {
            // ... (La lógica para ejecutar herramientas no cambia) ...
            for (const toolCall of toolCalls) {
                // ... tu código para ejecutar las herramientas ...
                const functionName = toolCall.function.name;
                const functionArgs = JSON.parse(toolCall.function.arguments);
                let functionResponse;

                if (functionName === "get_calendar_events") { functionResponse = await getCalendarEvents(functionArgs.timeMin, functionArgs.timeMax); } 
                else if (functionName === "create_calendar_event") { functionResponse = await createCalendarEvent(functionArgs.summary, functionArgs.startDateTime, functionArgs.endDateTime); }
                else if (functionName === "update_calendar_event") { functionResponse = await updateCalendarEvent(functionArgs.eventId, functionArgs.startDateTime, functionArgs.endDateTime); }
                
                let contentObject = functionResponse;
                if (functionName === 'get_calendar_events' && Array.isArray(functionResponse)) {
                    contentObject = functionResponse.map(event => ({ id: event.id, summary: event.summary, start: event.start.dateTime, end: event.end.dateTime }));
                }

                const contentString = JSON.stringify(contentObject) || '{"status": "La herramienta no devolvió resultado"}';
                messages.push({ tool_call_id: toolCall.id, role: "tool", name: functionName, content: contentString });
            }
            console.log("🧠 5. Volviendo a la IA con los resultados...");
        } else {
            const finalMessage = responseMessage.content;
            
            // --- GUARDAR MEMORIA EN POSTGRESQL ---
            try {
                // Guardamos el último mensaje del usuario
                await pool.query(`INSERT INTO messages (user_id, role, content) VALUES ($1, $2, $3)`, [userKey, 'user', texto]);
                // Guardamos la respuesta final del asistente
                await pool.query(`INSERT INTO messages (user_id, role, content) VALUES ($1, $2, $3)`, [userKey, 'assistant', finalMessage]);
                console.log("✅ Conversación guardada en PostgreSQL.");
            } catch (e) { console.error("Error al guardar en PostgreSQL:", e); }

            await enviarMensajeWhatsapp(finalMessage, from);
            return;
        }
    }
    await enviarMensajeWhatsapp("Parece que la tarea es muy compleja y me he perdido. ¿Podemos intentarlo de nuevo?", from);
}

// --- RESTO DEL ARCHIVO (SIN CAMBIOS) ---
// Aquí van todas tus otras funciones: enviarMensajeWhatsapp, endpoints, app.listen, etc.
// Asegúrate de que estén todas las funciones que usabas antes.

// --- FUNCIÓN AUXILIAR PARA ENVIAR MENSAJES ---
async function enviarMensajeWhatsapp(texto, numeroDestinatario) {
    console.log(`🚀 Intentando enviar mensaje a ${numeroDestinatario}...`);
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
        if (userText) { await procesarTextoConIA(userText, from); }
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
        console.log("--- ¡REFRESH TOKEN OBTENIDO! ---");
        console.log("Copia este token y guárdalo en tus variables de entorno como GOOGLE_REFRESH_TOKEN:");
        console.log(refreshToken);
        console.log("---------------------------------");
        res.send('¡Autorización completada con éxito! Ya puedes cerrar esta ventana y volver a WhatsApp.');
    } catch (error) {
        console.error("Error al obtener los tokens de Google:", error);
        res.status(500).send('Hubo un error durante la autorización. Inténtalo de nuevo.');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});