

const express = require("express");
const router = express.Router();
const Task = require("../models/Task");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const dotenv = require("dotenv");
dotenv.config();

// Models
const { MoodLog } = require("./mood");
const { FocusLog } = require("./focus");
const QuizData = require("../models/Quiz");

// Gemini setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// POST /api/tasks/add
router.post("/add", async (req, res) => {
  const { userId, title, estimatedTime = 15 } = req.body;

  if (!userId || !title) {
    return res.status(400).json({ error: "userId and title are required." });
  }

  const newTask = new Task({
    userId,
    title,
    date: new Date().toISOString().slice(0, 10),
    type: "personal",
    estimatedTime,
    completed: false,
    moodLevel: null,
    focusLevel: null,
  });

  try {
    const saved = await newTask.save();
    res.status(201).json(saved);
  } catch (err) {
    console.error("Error adding task:", err);
    res.status(500).json({ error: "Failed to add task." });
  }
});

// POST /api/tasks/update
router.post("/update", async (req, res) => {
  const { taskId, updates } = req.body;

  try {
    const updatedTask = await Task.findByIdAndUpdate(taskId, updates, { new: true });
    res.json(updatedTask);
  } catch (err) {
    console.error("Error updating task:", err);
    res.status(500).json({ error: "Failed to update task" });
  }
});

// DELETE /api/tasks/:id
router.delete("/delete/:id", async (req, res) => {
  try {
    const deleted = await Task.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Task not found." });
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting task:", err);
    res.status(500).json({ error: "Failed to delete task." });
  }
});

// GET /api/tasks/smart-generate


router.get("/smart-generate/:userId", async (req, res) => {

  const { userId } = req.params;
  if (!userId) return res.status(400).json({ error: "userId required" });

  try {
    const [moodLog, focusLog, quiz] = await Promise.all([
      MoodLog.findOne({ userId }).sort({ timestamp: -1 }),
      FocusLog.findOne({ userId }).sort({ timestamp: -1 }),
      QuizData.findOne({ userId }).sort({ createdAt: -1 }),
    ]);

    const mood = moodLog?.mood ?? 50;
    const focus = focusLog?.visible ? 1 : 0;

    if (!quiz) {
      return res.status(400).json({ error: "Quiz data not found." });
    }

    let inferredConditions = [];

    if (Array.isArray(quiz.answers)) {
      // Fallback to primaryCondition or inferredScores
      if (quiz.primaryCondition) {
        inferredConditions = [quiz.primaryCondition];
      } else if (quiz.inferredScores) {
        inferredConditions = Object.entries(quiz.inferredScores)
          .filter(([_, score]) => score > 0)
          .map(([cond]) => cond);
      }
    } else if (typeof quiz.answers === "object") {
      inferredConditions = quiz.answers.inferredCondition || [];
    }


    const prompt = `
You are a helpful mental health assistant AI.

The user has the following diagnosed or inferred conditions:
${
  Array.isArray(inferredConditions)
    ? inferredConditions.join(", ")
    : inferredConditions
}

Their latest mood level (scale 0–100): ${mood}
Their focus level (1 = focused, 0 = not focused): ${focus}

Please generate a personalized daily routine that:
- Takes into account their condition(s).
- Is adjusted to their current mood and focus state.
- Includes light, manageable tasks.
- Includes supportive habits or mindfulness ideas.
- Is compassionate and avoids overwhelming the user.

Return your response strictly as a JSON array like this:
[
  { "title": "Gentle stretching exercise", "estimatedTime": 5 },
  { "title": "Deep breathing for calm", "estimatedTime": 10 }
]
`;

    let result, text;
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      result = await model.generateContent(prompt);
      text = result.response.text().trim();
      console.log("💡 Gemini Response:\n", text);
    } catch (err) {
      console.error("❌ Gemini API error:", err);
      return res
        .status(500)
        .json({ error: "Failed to get response from Gemini." });
    }

    // Parse JSON safely
    let jsonTextMatch = text.match(/```json\s*([\s\S]*?)```/i);
    let jsonOnly = jsonTextMatch ? jsonTextMatch[1] : text;

    let tasks;
    try {
      tasks = JSON.parse(jsonOnly);
      if (!Array.isArray(tasks)) throw new Error("Not an array");
    } catch (e) {
      console.error("Gemini returned invalid JSON:", jsonOnly);
      return res
        .status(500)
        .json({ error: "Gemini returned invalid task format." });
    }

    // Save tasks to DB
    const date = new Date().toISOString().slice(0, 10);
    const savedTasks = await Task.insertMany(
      tasks.map((t) => ({
        ...t,
        userId,
        date,
        type: "smart",
        moodLevel: mood,
        focusLevel: focus,
        conditions: inferredConditions,
        completed: false,
      }))
    );

    res.json(savedTasks);
  } catch (err) {
    console.error("🔥 AI Routine Generation Error:", err);
    res.status(500).json({ error: "Failed to generate smart routine" });
  }
});



// GET /api/tasks/streak
router.get("/streak", async (req, res) => {
  const { userId } = req.query;
  const today = new Date().toISOString().slice(0, 10);
  const tasks = await Task.find({ userId }).sort({ date: -1 });

  let streak = 0;
  let current = new Date(today);

  const grouped = tasks.reduce((acc, t) => {
    acc[t.date] = acc[t.date] || [];
    acc[t.date].push(t);
    return acc;
  }, {});

  for (let [date, dayTasks] of Object.entries(grouped)) {
    const allComplete = dayTasks.every((t) => t.completed);
    if (allComplete) {
      streak++;
      current.setDate(current.getDate() - 1);
    } else break;
  }

  res.json({ streak });
});

// GET /api/tasks/completion-history
router.get("/completion-history", async (req, res) => {
  const { userId } = req.query;

  const logs = await Task.find({ userId }).sort({ date: -1 });
  const history = {};

  logs.forEach((task) => {
    const date = task.date;
    if (!history[date]) history[date] = { completed: 0, total: 0 };
    history[date].total += 1;
    if (task.completed) history[date].completed += 1;
  });

  const result = Object.entries(history)
    .slice(-7)
    .map(([date, val]) => ({
      date,
      percent: ((val.completed / val.total) * 100).toFixed(0),
    }));

  res.json(result);
});

// GET /api/tasks/all
router.get("/all/:userId", async (req, res) => {

  const { userId } = req.params;

  if (!userId) {
    return res.status(400).json({ error: "userId is required in query." });
  }

  try {
    const tasks = await Task.find({ userId }).sort({ date: -1 });
    res.json(tasks);
  } catch (err) {
    console.error("Error fetching tasks:", err);
    res.status(500).json({ error: "Failed to fetch tasks." });
  }
});


module.exports = router;
