import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import OpenAI from "openai";

const app = express();
app.use(bodyParser.json());

// Variables de entorno (Railway → Settings → Variables)
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Endpoint de verificación (GET)
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

// Endpoint de mensajes (POST)
app.post("/webhook", async (req, res) => {
  const entry = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (entry) {
    const from = entry.from; // número del usuario que escribe
    const text = entry.text?.body;

    console.log("Mensaje recibido:", text);

    // 👉 Pedimos respuesta a ChatGPT
    let respuesta = "No entendí, ¿puedes repetirlo?";

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: text }]
      });

      respuesta = completion.choices[0].message.content;
    } catch (error) {
      console.error("Error con OpenAI:", error);
    }

    // 👉 Enviar respuesta por WhatsApp
    await fetch(`https://graph.facebook.com
