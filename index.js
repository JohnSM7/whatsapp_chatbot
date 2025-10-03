import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import OpenAI from "openai";
import { google } from 'googleapis';

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
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN; // <--- Nueva variable

// --- CONFIGURACIÓN DE GOOGLE ---
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

// Carga el refresh token si existe
if (GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({
    refresh_token: GOOGLE_REFRESH_TOKEN
  });
}

// Crea una instancia del cliente de Google Calendar autenticado
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// --- FUNCIÓN AUXILIAR PARA ENVIAR MENSAJES ---
async function enviarMensajeWhatsapp(texto, numeroDestinatario) {
  try {
    await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
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
    console.log(`Respuesta enviada a ${numeroDestinatario}.`);
  } catch (error) {
    console.error("Error al enviar mensaje a WhatsApp:", error);
  }
}

// --- ENDPOINTS ---
app.get("/webhook", (req, res) => {
    // Tu código de verificación... (sin cambios)
});

app.post("/webhook", async (req, res) => {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (entry && entry.text) {
        const from = entry.from;
        const text = entry.text.body;
        console.log("Mensaje recibido:", text);

        // --- MANEJO DE COMANDOS ---
        if (text.toLowerCase() === "/conectar_google") {
            // Lógica para generar y enviar la URL de autorización... (sin cambios)
        } else if (text.toLowerCase() === "/ver_agenda") {
            if (!GOOGLE_REFRESH_TOKEN) {
                await enviarMensajeWhatsapp("Necesitas conectar tu cuenta de Google primero. Envía '/conectar_google'.", from);
                return res.sendStatus(200);
            }
            try {
                // Petición a la API de Google Calendar
                const response = await calendar.events.list({
                    calendarId: 'primary', // 'primary' es tu calendario principal
                    timeMin: (new Date()).toISOString(),
                    maxResults: 5, // Los próximos 5 eventos
                    singleEvents: true,
                    orderBy: 'startTime',
                });

                const events = response.data.items;
                if (!events || events.length === 0) {
                    await enviarMensajeWhatsapp("¡No tienes próximos eventos en tu agenda!", from);
                } else {
                    let respuesta = "Tus próximos 5 eventos son:\n\n";
                    events.forEach(event => {
                        const start = new Date(event.start.dateTime || event.start.date);
                        // Formateamos la fecha para que sea legible
                        const fechaFormateada = start.toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
                        respuesta += `🗓️ ${event.summary} - ${fechaFormateada}\n`;
                    });
                    await enviarMensajeWhatsapp(respuesta, from);
                }
            } catch (error) {
                console.error("Error al consultar Google Calendar:", error);
                await enviarMensajeWhatsapp("Lo siento, no pude consultar tu agenda.", from);
            }
        } else {
            // Lógica de OpenAI... (sin cambios)
        }
    }
    res.sendStatus(200);
});

app.get('/oauth2callback', async (req, res) => {
    // Tu código para obtener el refresh token... (sin cambios)
});

// --- INICIAR SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});