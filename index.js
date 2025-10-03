import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import OpenAI from "openai";
import { google } from 'googleapis'; // <--- AÑADIDO

const app = express();
app.use(bodyParser.json());

// --- VARIABLES DE ENTORNO ---
// WhatsApp y OpenAI
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Google Calendar (Asegúrate de añadirlas en Railway)
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

// --- CONFIGURACIÓN DE GOOGLE ---
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

// --- FUNCIÓN AUXILIAR PARA ENVIAR MENSAJES ---
// He movido la lógica de envío aquí para poder reutilizarla
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

// --- ENDPOINTS DE LA APLICACIÓN ---

// Endpoint de verificación del Webhook de WhatsApp (GET)
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

// Endpoint principal para recibir mensajes de WhatsApp (POST)
app.post("/webhook", async (req, res) => {
  const entry = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (entry && entry.text) {
    const from = entry.from; // Número del usuario que escribe
    const text = entry.text.body;

    console.log("Mensaje recibido:", text);

    // Lógica para manejar comandos especiales o conversaciones
    if (text.toLowerCase() === "/conectar_google") {
      // 1. Genera la URL para que el usuario dé su consentimiento
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline', // Pide un refresh_token
        scope: ['https://www.googleapis.com/auth/calendar'], // Permiso para el calendario
      });
      
      // 2. Envía la URL al usuario
      await enviarMensajeWhatsapp(`Para autorizar el acceso a tu Google Calendar, haz clic en el siguiente enlace:\n\n${authUrl}`, from);

    } else {
      // 3. Si no es un comando, habla con OpenAI
      let respuesta = "No entendí, ¿puedes repetirlo?";
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: text }],
        });
        respuesta = completion.choices[0].message.content;
      } catch (error) {
        console.error("Error con OpenAI:", error);
        respuesta = "Lo siento, tengo problemas para conectarme con mi cerebro de IA en este momento. 🤖";
      }

      await enviarMensajeWhatsapp(respuesta, from);
    }
  }

  res.sendStatus(200); // Responde a Meta para confirmar recepción
});


// --- NUEVO ENDPOINT PARA EL CALLBACK DE GOOGLE (GET) ---
// Aquí es donde Google redirige al usuario después de la autorización
app.get('/oauth2callback', async (req, res) => {
    const code = req.query.code; // Google nos da un código de autorización

    try {
        // 1. Intercambiamos el código por los tokens
        const { tokens } = await oauth2Client.getToken(code);
        const refreshToken = tokens.refresh_token;

        // 2. Mostramos el Refresh Token en la consola para que lo copies
        console.log("--- ¡REFRESH TOKEN OBTENIDO! ---");
        console.log("Copia este token y guárdalo en tus variables de entorno como GOOGLE_REFRESH_TOKEN:");
        console.log(refreshToken);
        console.log("---------------------------------");
        
        // 3. Enviamos una respuesta al navegador del usuario
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