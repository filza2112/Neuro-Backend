const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

// Mood Schema
const moodSchema = new mongoose.Schema({
  userId: String,
  timestamp: Date,
  mood: Number,
  why: String,
  tags: [String],
});

const MoodLog = mongoose.model("MoodLog", moodSchema);

// POST: Save mood entry
router.post("/submit", async (req, res) => {
  try {
    const { userId, mood, emoji, why, tags, timestamp } = req.body;

    const entry = new MoodLog({ userId, mood, emoji, why, tags, timestamp });

    await entry.save();

    res.status(201).json({ message: "Mood saved" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET: Get mood history
router.get("/all/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const logs = await MoodLog.find({ userId }).sort({ timestamp: 1 });
    res.json(logs); // make sure this is an array
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Example Express.js code
router.post("/api/mood/submit", async (req, res) => {
  const { userId, mood, label, emoji, why, timestamp } = req.body;

  try {
    await Mood.create({ userId, mood, label, emoji, why, timestamp }); // MongoDB model
    res.status(200).json({ message: "Mood saved" });
  } catch (err) {
    console.error("DB error:", err);
    res.status(500).json({ error: "Failed to save mood" });
  }
});

router.get("/calendar/:userId", async (req, res) => {
  try {
    const data = await Mood.find({ userId: req.params.userId });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch mood logs" });
  }
});

module.exports = { router, MoodLog };