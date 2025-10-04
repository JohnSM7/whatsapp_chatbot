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

// --- VARIABLES DE ENTORNO ---
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

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

// --- DEFINICIÓN DE HERRAMIENTAS PARA OPENAI ---
const tools = [
  {
    type: "function",
    function: {
      name: "get_calendar_events",
      description: "Obtiene una lista de eventos del calendario de Google para un rango de fechas. Es útil para encontrar eventos antes de modificarlos.",
      parameters: {
        type: "object",
        properties: {
          timeMin: { type: "string", description: "Fecha y hora de inicio en formato ISO 8601." },
          timeMax: { type: "string", description: "Fecha y hora de fin en formato ISO 8601." },
        },
        required: ["timeMin", "timeMax"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_calendar_event",
      description: "Crea un nuevo evento en el calendario de Google.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "El título del evento." },
          startDateTime: { type: "string", description: "Fecha y hora de inicio en formato ISO 8601." },
          endDateTime: { type: "string", description: "Fecha y hora de fin en formato ISO 8601." },
        },
        required: ["summary", "startDateTime", "endDateTime"],
      },
    },
  },
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

// --- FUNCIONES DE HERRAMIENTAS (LAS MANOS) ---
async function getCalendarEvents(timeMin, timeMax) {
  if (!timeMin || !timeMax) {
      console.error("Error: La herramienta get_calendar_events fue llamada sin fechas.");
      return [];
  }
  try {
    const calendarList = await calendar.calendarList.list();
    const calendars = calendarList.data.items;
    const eventPromises = calendars.map(cal => {
        return calendar.events.list({
            calendarId: cal.id, timeMin, timeMax, maxResults: 50, singleEvents: true, orderBy: 'startTime',
        });
    });
    const allEventResponses = await Promise.all(eventPromises);
    let allEvents = [];
    allEventResponses.forEach(response => {
        if (response.data.items) { allEvents = allEvents.concat(response.data.items); }
    });
    allEvents.sort((a, b) => new Date(a.start.dateTime || a.start.date) - new Date(b.start.dateTime || b.start.date));
    return allEvents.slice(0, 25);
  } catch (error) {
    console.error("Error al obtener eventos del calendario:", error);
    return { error: "No se pudieron obtener los eventos." };
  }
}

async function createCalendarEvent(summary, startDateTime, endDateTime) {
  try {
    const response = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary,
        start: { dateTime: startDateTime, timeZone: 'Europe/Madrid' },
        end: { dateTime: endDateTime, timeZone: 'Europe/Madrid' },
      },
    });
    return response.data;
  } catch (error) {
    console.error("Error al crear el evento:", error);
    return { error: "No se pudo crear el evento." };
  }
}

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

// --- FUNCIÓN DE TRANSCRIPCIÓN DE AUDIO (LOS OÍDOS) ---
async function transcribeAudio(mediaId) {
    try {
        const mediaUrlResponse = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } });
        const mediaUrl = mediaUrlResponse.data.url;
        const audioResponse = await axios({ url: mediaUrl, method: 'GET', responseType: 'stream', headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } });
        const tempPath = path.join('/tmp', `${mediaId}.ogg`);
        const writer = fs.createWriteStream(tempPath);
        audioResponse.data.pipe(writer);
        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
        const transcription = await openai.audio.transcriptions.create({ file: fs.createReadStream(tempPath), model: "whisper-1" });
        fs.unlinkSync(tempPath);
        return transcription.text;
    } catch (error) {
        console.error("Error al transcribir el audio:", error.response ? error.response.data : error.message);
        return { error: "No se pudo procesar el audio." };
    }
}

// --- FUNCIÓN PRINCIPAL DE PROCESAMIENTO (EL CEREBRO) ---
async function procesarTextoConIA(texto, from) {
    console.log("🧠 1. Iniciando procesamiento con IA...");
    const currentDate = new Date().toISOString();
    
    // La conversación empieza con el contexto del sistema y el mensaje del usuario
    const messages = [
        { 
            role: "system", 
            content: `Eres un asistente de WhatsApp llamado Oráculo. La fecha y hora actual es ${currentDate}. Tu objetivo es ser extremadamente conciso y útil. Cuando el usuario pida mover un evento, primero debes usar la herramienta 'get_calendar_events' para encontrar el evento y obtener su ID, y luego usar la herramienta 'update_calendar_event' con ese ID para moverlo a la nueva fecha. Puedes llamar a múltiples herramientas si es necesario. Resume la información y formatea tu respuesta de manera clara y amigable.`
        },
        { role: "user", content: texto }
    ];

    // --- INICIO DEL NUEVO BUCLE DE CONVERSACIÓN ---
    let maxTurns = 5; // Límite de seguridad para evitar bucles infinitos
    while (maxTurns > 0) {
        maxTurns--;

        const response = await openai.chat.completions.create({
            model: "gpt-4o", 
            messages: messages, 
            tools: tools, 
            tool_choice: "auto",
        });
        
        const responseMessage = response.choices[0].message;
        const toolCalls = responseMessage.tool_calls;

        if (toolCalls) {
            console.log("🧠 2a. La IA ha decidido usar una o más herramientas.");
            messages.push(responseMessage); // Añadir la decisión de la IA al historial
            
            // Ejecutar cada herramienta que la IA solicitó
            for (const toolCall of toolCalls) {
                const functionName = toolCall.function.name;
                const functionArgs = JSON.parse(toolCall.function.arguments);
                let functionResponse;

                console.log(`🧠 3. Ejecutando herramienta: ${functionName} con argumentos:`, functionArgs);

                if (functionName === "get_calendar_events") {
                    functionResponse = await getCalendarEvents(functionArgs.timeMin, functionArgs.timeMax);
                } else if (functionName === "create_calendar_event") {
                    functionResponse = await createCalendarEvent(functionArgs.summary, functionArgs.startDateTime, functionArgs.endDateTime);
                } else if (functionName === "update_calendar_event") {
                    functionResponse = await updateCalendarEvent(functionArgs.eventId, functionArgs.startDateTime, functionArgs.endDateTime);
                }
                
                console.log("🧠 4. Resultado de la herramienta:", functionResponse);

                let contentObject = functionResponse;
                if (functionName === 'get_calendar_events' && Array.isArray(functionResponse)) {
                    contentObject = functionResponse.map(event => ({ id: event.id, summary: event.summary, start: event.start.dateTime, end: event.end.dateTime }));
                    console.log("🧠 4b. Resultado resumido para la IA:", contentObject);
                }

                const contentString = JSON.stringify(contentObject) || '{"status": "La herramienta no devolvió resultado"}';
                
                // Añadir el resultado de la herramienta al historial
                messages.push({
                    tool_call_id: toolCall.id,
                    role: "tool",
                    name: functionName,
                    content: contentString,
                });
            }
            // Continuar con la siguiente iteración del bucle para que la IA decida el siguiente paso
            console.log("🧠 5. Volviendo a la IA con los resultados de las herramientas...");

        } else {
            // Si no hay más llamadas a herramientas, la IA ha terminado y da su respuesta final
            const finalMessage = responseMessage.content;
            console.log("🧠 6. Respuesta final de la IA:", finalMessage);
            await enviarMensajeWhatsapp(finalMessage, from);
            return; // Salir de la función
        }
    }
    // Si se alcanza el límite de turnos, enviar un mensaje de error
    await enviarMensajeWhatsapp("Parece que la tarea es muy compleja y me he perdido. ¿Podemos intentarlo de nuevo de una forma más simple?", from);
}

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