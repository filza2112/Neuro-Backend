const ChatLog = require("../models/ChatLog");
const { analyzeSentiment } = require("../services/sentiment");
const { classifyTone } = require("../services/tone");
const { extractKeywords } = require("../services/keywords");
const { sendAlertEmail } = require("../services/email");
const { getGeminiResponse } = require("../services/gemini");
const EmotionTrigger = require("../models/EmotionTrigger");

const NEGATIVE_THRESHOLD = -0.6;
const ALERT_TONES = ["angry", "anxious", "frustrated"];

exports.analyzeMessage = async (req, res) => {
  try {
    const { text, userId, email, isFollowUp } = req.body;
    if (!userId || !text)
      return res.status(400).json({ error: "Missing userId or text" });

    const sentiment = await analyzeSentiment(text);
    const tone = await classifyTone(text);
    let alertTriggered = false;
    let keywords = [];

    // 👇 Build memory from last 8 chat logs
    const logs = await ChatLog.find({ userId })
      .sort({ timestamp: -1 })
      .limit(8)
      .lean();
    const history = logs
      .reverse()
      .map(
        (log) => `${log.sender === "user" ? "User" : "Assistant"}: ${log.text}`
      );
    history.push(`User: ${text}`);
    history.push("Assistant:");

    let prompt = "";

    // Handle follow-up emotion explanation
    if (isFollowUp && Math.abs(sentiment.score) > 0.4) {
      keywords = await extractKeywords(text);

      await new ChatLog({
        userId,
        text,
        sender: "user",
        timestamp: new Date(),
        sentiment: sentiment.sentiment,
        score: sentiment.score,
        tone,
        trigger_keywords: keywords,
        alert_triggered: false,
        isFollowUp: true, // optional: helpful for later filtering
      }).save();

      prompt = `The user added more context about feeling ${tone}: "${text}". Respond with warmth and do not ask again what triggered it.\n\n${history.join(
        "\n"
      )}`;
    }

    // Strong emotion detected
    else if (Math.abs(sentiment.score) > 0.6 || ALERT_TONES.includes(tone)) {
      keywords = await extractKeywords(text);
      alertTriggered =
        sentiment.score < NEGATIVE_THRESHOLD || ALERT_TONES.includes(tone);
      prompt = `You are a caring assistant.\nUser said: "${text}".\nSentiment: ${
        sentiment.sentiment
      } (${sentiment.score.toFixed(
        2
      )}), Tone: ${tone}.\nAsk empathetically: What happened? What triggered this feeling?\n\n${history.join(
        "\n"
      )}`;
    }

    // Neutral/mild
    else {
      prompt = `You're a friendly assistant.\nUser said: "${text}".\nRespond warmly and continue the conversation.\n\n${history.join(
        "\n"
      )}`;
    }

    const botResponse = await getGeminiResponse(prompt);

    // Save message to ChatLog (optional: remove this if only trigger data should be stored)
    const entry = new ChatLog({
      userId,
      text,
      sender: "user", // 🧠 Add sender for history
      timestamp: new Date(),
      sentiment: sentiment.sentiment,
      score: sentiment.score,
      tone,
      trigger_keywords: keywords.length ? keywords : undefined,
      alert_triggered: alertTriggered,
    });
    await entry.save();

    // Optional bot message save (if you want to reconstruct full chat)
    await new ChatLog({
      userId,
      text: botResponse,
      sender: "bot",
      timestamp: new Date(),
    }).save();

    if (alertTriggered && email) {
      await sendAlertEmail(
        email,
        "🛑 NeuroBridge Alert: Mood Warning",
        `User ${userId} has shown signs of distress.\n\nMessage: "${text}"\nTone: ${tone}\nSentiment score: ${sentiment.score}`
      );
    }

    res.json({
      sentiment,
      tone,
      keywords,
      alert_triggered: alertTriggered,
      botResponse,
    });
  } catch (err) {
    console.error("Error in chatController:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

// Get all chat logs for a user (most recent first)
exports.getUserLogs = async (req, res) => {
  try {
    const { userId } = req.params;
    const logs = await ChatLog.find({ userId }).sort({ timestamp: -1 });
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch chat logs" });
  }
};

// Get a summary of chat logs for a user
exports.getSummary = async (req, res) => {
  try {
    const { userId } = req.params;
    const logs = await ChatLog.find({ userId });

    const total = logs.length;
    const negative = logs.filter((log) => log.score < 0).length;
    const alerts = logs.filter((log) => log.alert_triggered).length;
    const avgScore = total
      ? logs.reduce((sum, log) => sum + (log.score || 0), 0) / total
      : 0;

    res.json({
      total,
      negative,
      alerts,
      avgScore,
      lastMessage: logs[0]?.text || null,
      lastTimestamp: logs[0]?.timestamp || null,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch summary" });
  }
};



exports.getGeminiResponse = async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const response = await getGeminiResponse(prompt);
    res.json({ response });
  } catch (err) {
    console.error("Error generating Gemini response:", err);
    res.status(500).json({ error: "Failed to generate Gemini response" });
  }
};

// GET /api/chat/top-triggers/:userId
// GET /api/chat/top-triggers/:userId
exports.getTopTriggers = async (req, res) => {
  try {
    const { userId } = req.params;

    const logs = await ChatLog.find({ userId, alert_triggered: true, trigger_keywords: { $exists: true, $not: { $size: 0 } } });

    const keywordMap = {};

    logs.forEach((log) => {
      (log.trigger_keywords || []).forEach((kw) => {
        const key = kw.toLowerCase();
        if (!keywordMap[key]) {
          keywordMap[key] = { count: 0, tone: log.tone };
        }
        keywordMap[key].count += 1;
      });
    });

    // Convert to sorted array
    const sorted = Object.entries(keywordMap)
      .map(([trigger, { count, tone }]) => ({ trigger, count, tone }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    res.json(sorted);
  } catch (err) {
    console.error("Error in getTopTriggers:", err);
    res.status(500).json({ error: "Failed to fetch top triggers" });
  }
};

