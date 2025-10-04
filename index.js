import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import OpenAI from "openai";
import { google } from 'googleapis';
import fs from 'fs';
import axios from 'axios';
import path from 'path';

const app = express();
app.use(bodyParser.json());

// --- VARIABLES DE ENTORNO (sin cambios) ---
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

// --- CONFIGURACIÓN DE GOOGLE (sin cambios) ---
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

if (GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({
    refresh_token: GOOGLE_REFRESH_TOKEN
  });
}
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// --- DEFINICIÓN DE HERRAMIENTAS PARA OPENAI (CON CAMBIOS) ---
const tools = [
  {
    type: "function",
    function: {
      name: "get_calendar_events",
      description: "Obtiene una lista de eventos del calendario de Google para un rango de fechas. Es útil para encontrar eventos antes de modificarlos.",
      parameters: { /* ... (sin cambios) ... */ },
    },
  },
  {
    type: "function",
    function: {
      name: "create_calendar_event",
      description: "Crea un nuevo evento en el calendario de Google.",
      parameters: { /* ... (sin cambios) ... */ },
    },
  },
  // --- NUEVA HERRAMIENTA AÑADIDA ---
  {
    type: "function",
    function: {
        name: "update_calendar_event",
        description: "Modifica o mueve un evento existente en el calendario de Google. Necesita el ID del evento.",
        parameters: {
            type: "object",
            properties: {
                eventId: { type: "string", description: "El ID del evento a modificar. Se debe obtener primero buscando el evento." },
                startDateTime: { type: "string", description: "La nueva fecha y hora de inicio en formato ISO 8601." },
                endDateTime: { type: "string", description: "La nueva fecha y hora de fin en formato ISO 8601." },
            },
            required: ["eventId", "startDateTime", "endDateTime"],
        },
    },
  },
];


// --- FUNCIONES DE HERRAMIENTAS (CON CAMBIOS) ---
async function getCalendarEvents(timeMin, timeMax) { /* ... (sin cambios) ... */ }
async function createCalendarEvent(summary, startDateTime, endDateTime) { /* ... (sin cambios) ... */ }

// --- NUEVA FUNCIÓN AÑADIDA ---
async function updateCalendarEvent(eventId, startDateTime, endDateTime) {
  try {
    const response = await calendar.events.patch({
      calendarId: 'primary',
      eventId: eventId,
      requestBody: {
        start: { dateTime: startDateTime, timeZone: 'Europe/Madrid' },
        end: { dateTime: endDateTime, timeZone: 'Europe/Madrid' },
      },
    });
    return response.data;
  } catch (error) {
    console.error(`Error al actualizar el evento ${eventId}:`, error);
    return { error: "No se pudo actualizar el evento." };
  }
}

// --- FUNCIÓN DE TRANSCRIPCIÓN DE AUDIO (sin cambios) ---
async function transcribeAudio(mediaId) { /* ... (sin cambios) ... */ }

// --- FUNCIÓN PRINCIPAL DE PROCESAMIENTO (CON CAMBIOS) ---
async function procesarTextoConIA(texto, from) {
    console.log("🧠 1. Iniciando procesamiento con IA...");
    const currentDate = new Date().toISOString();
    
    const messages = [
        { 
            role: "system", 
            content: `Eres un asistente de WhatsApp llamado Oráculo. La fecha y hora actual es ${currentDate}. Tu objetivo es ser extremadamente conciso y útil. Cuando el usuario pida mover un evento, primero debes usar la herramienta 'get_calendar_events' para encontrar el evento y obtener su ID, y luego usar la herramienta 'update_calendar_event' con ese ID para moverlo a la nueva fecha. Resume la información y formatea tu respuesta de manera clara y amigable.`
        },
        { role: "user", content: texto }
    ];

    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: messages,
        tools: tools,
        tool_choice: "auto",
    });
    
    const responseMessage = response.choices[0].message;
    const toolCalls = responseMessage.tool_calls;

    if (toolCalls) {
        console.log("🧠 2a. La IA ha decidido usar una herramienta.");
        messages.push(responseMessage);
        
        for (const toolCall of toolCalls) {
            const functionName = toolCall.function.name;
            const functionArgs = JSON.parse(toolCall.function.arguments);
            let functionResponse;

            console.log(`🧠 3. Ejecutando herramienta: ${functionName} con argumentos:`, functionArgs);

            // --- LÓGICA DE HERRAMIENTAS ACTUALIZADA ---
            if (functionName === "get_calendar_events") {
                functionResponse = await getCalendarEvents(functionArgs.timeMin, functionArgs.timeMax);
            } else if (functionName === "create_calendar_event") {
                functionResponse = await createCalendarEvent(functionArgs.summary, functionArgs.startDateTime, functionArgs.endDateTime);
            } else if (functionName === "update_calendar_event") {
                functionResponse = await updateCalendarEvent(functionArgs.eventId, functionArgs.startDateTime, functionArgs.endDateTime);
            }
            
            console.log("🧠 4. Resultado de la herramienta:", functionResponse);

            messages.push({
                tool_call_id: toolCall.id,
                role: "tool",
                name: functionName,
                content: JSON.stringify(functionResponse),
            });
        }
        
        console.log("🧠 5. Enviando resultado a OpenAI para obtener respuesta final...");
        const finalResponse = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: messages,
        });

        const finalMessage = finalResponse.choices[0].message.content;
        console.log("🧠 6. Respuesta final de la IA:", finalMessage);
        await enviarMensajeWhatsapp(finalMessage, from);

    } else {
        const simpleMessage = responseMessage.content;
        console.log("🧠 2b. La IA ha respondido directamente:", simpleMessage);
        await enviarMensajeWhatsapp(simpleMessage, from);
    }
}

// --- FUNCIÓN AUXILIAR PARA ENVIAR MENSAJES ---
async function enviarMensajeWhatsapp(texto, numeroDestinatario) {
    console.log(`🚀 Intentando enviar mensaje a ${numeroDestinatario}...`);
    try {
        const response = await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
            },
            body: JSON.stringify({
                messaging_product: "whatsapp",
                to: numeroDestinatario,
                text: { body: texto },
            }),
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

    if (mode && token === VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
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
            await procesarTextoConIA(userText, from);
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

// --- INICIAR SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});