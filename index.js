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
  oauth2Client.setCredentials({
    refresh_token: GOOGLE_REFRESH_TOKEN
  });
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
    const calendarList = await calendar.calendarList.list();
    const calendars = calendarList.data.items;

    const eventPromises = calendars.map(cal => {
        return calendar.events.list({
            calendarId: cal.id,
            timeMin,
            timeMax,
            maxResults: 50,
            singleEvents: true,
            orderBy: 'startTime',
        });
    });

    const allEventResponses = await Promise.all(eventPromises);
    let allEvents = [];
    allEventResponses.forEach(response => {
        if (response.data.items) {
            allEvents = allEvents.concat(response.data.items);
        }
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
        start: { dateTime: startDateTime, timeZone: 'Europe/Madrid' }, // Ajusta tu zona horaria si es necesario
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
        const mediaUrlResponse = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
        });
        const mediaUrl = mediaUrlResponse.data.url;

        const audioResponse = await axios({
            url: mediaUrl,
            method: 'GET',
            responseType: 'stream',
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
        });
        
        const tempPath = path.join('/tmp', `${mediaId}.ogg`);
        const writer = fs.createWriteStream(tempPath);
        audioResponse.data.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempPath),
            model: "whisper-1",
        });

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
    
    const messages = [
        { 
            role: "system", 
            content: `Eres un asistente de WhatsApp llamado Oráculo. La fecha y hora actual es ${currentDate}. Tu objetivo es ser extremadamente conciso y útil. Cuando muestres eventos del calendario, resume la información: muestra solo el título y la hora. NUNCA incluyas descripciones largas, enlaces de Google Meet, o IDs de eventos a menos que el usuario te lo pida explícitamente. Formatea tu respuesta de manera clara y amigable.`
        },
        { 
            role: "user", 
            content: texto 
        }
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
            let functionResponse