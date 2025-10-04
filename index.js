import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import OpenAI from "openai";
import { google } from 'googleapis';
import fs from 'fs';          // <--- Para manejar archivos
import axios from 'axios';    // <--- Para descargar el audio
import path from 'path';      // <--- Para manejar rutas de archivos

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
      description: "Obtiene una lista de eventos del calendario de Google para un rango de fechas.",
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
];

// --- FUNCIONES DE HERRAMIENTAS (LAS MANOS) ---
async function getCalendarEvents(timeMin, timeMax) {
  try {
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      maxResults: 10,
      singleEvents: true,
      orderBy: 'startTime',
    });
    return response.data.items;
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

// --- FUNCIÓN DE TRANSCRIPCIÓN DE AUDIO (LOS OÍDOS) ---
async function transcribeAudio(mediaId) {
    try {
        // 1. Obtener la URL del archivo de audio
        const mediaUrlResponse = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
        });
        const mediaUrl = mediaUrlResponse.data.url;

        // 2. Descargar el archivo de audio
        const audioResponse = await axios({
            url: mediaUrl,
            method: 'GET',
            responseType: 'stream',
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
        });
        
        // 3. Guardar el audio en un archivo temporal
        const tempPath = path.join('/tmp', `${mediaId}.ogg`); // Railway permite escribir en /tmp
        const writer = fs.createWriteStream(tempPath);
        audioResponse.data.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // 4. Enviar a Whisper para transcribir
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempPath),
            model: "whisper-1",
        });

        // 5. Borrar el archivo temporal
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
    
    // --- INICIO DE LA CORRECCIÓN ---
    // Obtenemos la fecha actual en formato ISO para dársela a la IA
    const currentDate = new Date().toISOString();
    
    // Creamos una lista de mensajes que incluye el contexto de la fecha actual
    const messages = [
        { 
            role: "system", 
            content: `Eres un asistente de WhatsApp. La fecha y hora actual es ${currentDate}. Usa esta información para interpretar las peticiones de fechas del usuario (como "hoy", "mañana", "el próximo lunes").`
        },
        { 
            role: "user", 
            content: texto 
        }
    ];
    // --- FIN DE LA CORRECCIÓN ---

    // 1. Primera llamada a OpenAI
    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: messages, // Usamos la nueva lista de mensajes con el contexto
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

            if (functionName === "get_calendar_events") {
                functionResponse = await getCalendarEvents(functionArgs.timeMin, functionArgs.timeMax);
            } else if (functionName === "create_calendar_event") {
                functionResponse = await createCalendarEvent(functionArgs.summary, functionArgs.startDateTime, functionArgs.endDateTime);
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

// --- ENDPOINTS Y SERVIDOR ---
app.get("/webhook", (req, res) => { /* ... tu código de verificación ... */ });

app.post("/webhook", async (req, res) => {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!entry) return res.sendStatus(200);

    const from = entry.from;
    let userText;

    if (entry.text) {
        // Mensaje de texto
        userText = entry.text.body;
        console.log("Mensaje de texto recibido:", userText);
    } else if (entry.audio) {
        // Mensaje de audio
        console.log("Mensaje de audio recibido. Transcribiendo...");
        userText = await transcribeAudio(entry.audio.id);
        if (userText.error) {
            await enviarMensajeWhatsapp("Lo siento, no pude entender tu audio.", from);
            return res.sendStatus(200);
        }
        await enviarMensajeWhatsapp(`He entendido: "${userText}"`, from);
    }

    if (userText) {
        try {
            await procesarTextoConIA(userText, from);
        } catch (error) {
            console.error("Error en el procesamiento de IA:", error);
            await enviarMensajeWhatsapp("Uups, algo salió mal en mi cerebro. Inténtalo de nuevo.", from);
        }
    }
    
    res.sendStatus(200);
});

app.get('/oauth2callback', async (req, res) => { /* ... tu código de callback ... */ });

// Iniciar servidor...
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Servidor escuchando en el puerto ${PORT}`); });

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