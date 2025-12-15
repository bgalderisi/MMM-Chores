const Log        = require("logger");
const NodeHelper = require("node_helper");
const express    = require("express");
const bodyParser = require("body-parser");
const path       = require("path");
const fs         = require("fs");
const https      = require("https");
const { exec }   = require("child_process");

// Use built-in fetch if available (Node 18+) otherwise fall back to node-fetch
let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args));
}

let openaiLoaded = true;
let OpenAI;
try {
  OpenAI = require("openai").OpenAI;
} catch (err) {
  openaiLoaded = false;
}

const DATA_FILE     = path.join(__dirname, "data.json");
const DATA_FILE_BAK = `${DATA_FILE}.bak`;
const CERT_DIR      = path.join(__dirname, "certs");

let tasks = [];
let people = [];
let analyticsBoards = [];
let sessions = {};
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

const DEFAULT_TITLES = [
  "Junior",
  "Apprentice",
  "Journeyman",
  "Experienced",
  "Expert",
  "Veteran",
  "Master",
  "Grandmaster",
  "Legend",
  "Mythic"
];

let settings = {};
let autoUpdateTimer = null;
let reminderTimer = null;
let midnightScanTimer = null;

function applyLoadedData(json, sourceLabel = "data.json") {
  tasks = json.tasks || [];
  
  // Initial sort to establish a baseline if order is missing
  if (tasks.some(t => t.order !== undefined)) {
    tasks.sort((a, b) => (a.order || 0) - (b.order || 0));
  }
  
  // Re-calculate fresh decimal orders on load
  applyTaskOrder();

  people          = json.people          || [];
  analyticsBoards = json.analyticsBoards || [];
  settings        = json.settings        || {};
  if (settings.openaiApiKey !== undefined) delete settings.openaiApiKey;
  if (settings.pushoverApiKey !== undefined) delete settings.pushoverApiKey;
  if (settings.pushoverUser !== undefined) delete settings.pushoverUser;

  updatePeopleLevels({});

  Log.log(
    `MMM-Chores: Loaded ${tasks.length} tasks, ${people.length} people, ${analyticsBoards.length} analytics boards from ${sourceLabel}`
  );
}

function writeDataFileAtomic(filePath, contents) {
  const dir = path.dirname(filePath);
  const tmpName = `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmpPath = path.join(dir, tmpName);
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, contents, { encoding: "utf8" });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch (cleanupErr) {
      Log.error("MMM-Chores: Failed to remove temporary data file", cleanupErr);
    }
    throw err;
  }
}

function getLocalISO(date) {
  const d = date || new Date();
  const offsetMs = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - offsetMs).toISOString().slice(0, -1);
}

function scheduleAutoUpdate() {
  if (!settings.autoUpdate) return;
  if (autoUpdateTimer) clearTimeout(autoUpdateTimer);
  const now = new Date();
  const next = new Date(now);
  next.setHours(4, 0, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  const delay = next - now;
  Log.log(`Auto update scheduled for ${next.toString()}`);
  autoUpdateTimer = setTimeout(() => {
    autoUpdateTimer = null;
    runAutoUpdate();
  }, delay);
}

function scheduleReminder(self) {
  if (reminderTimer) {
    clearTimeout(reminderTimer);
    reminderTimer = null;
  }
  if (!settings.reminderTime || !settings.pushoverEnabled) return;
  if (!self.config || !self.config.pushoverApiKey || !self.config.pushoverUser) {
    Log.error("MMM-Chores: pushoverApiKey and pushoverUser must be set in config.js when Pushover is enabled");
    self.sendSocketNotification(
      "PUSHOVER_CONFIG_ERROR",
      "Please set pushoverApiKey and pushoverUser in config.js to use Pushover notifications."
    );
    return;
  }
  const [h, m] = settings.reminderTime.split(":").map(n => parseInt(n, 10));
  if (isNaN(h) || isNaN(m)) return;
  const now = new Date();
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  const delay = next - now;
  Log.log(`Pushover reminder scheduled for ${next.toString()}`);
  reminderTimer = setTimeout(() => {
    reminderTimer = null;
    const todayStr = getLocalISO(new Date()).slice(0, 10);
    const unfinished = tasks.filter(
      t => !t.done && !t.deleted && t.date && t.date <= todayStr
    );
    if (unfinished.length) {
      const list = unfinished.map(t => `• ${t.name}`).join("\n");
      sendPushover(self, settings, `Uncompleted tasks:\n${list}`);
    }
    scheduleReminder(self);
  }, delay);
}

function scheduleMidnightScan(helper) {
  if (midnightScanTimer) clearTimeout(midnightScanTimer);
  
  const now = new Date();
  const next = new Date(now);
  next.setHours(0, 1, 0, 0);
  
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  
  const delay = next - now;
  Log.log(`Next daily task generation scheduled for ${next.toString()}`);
  
  midnightScanTimer = setTimeout(() => {
    midnightScanTimer = null;
    scanForMissedRecurrences(helper);
    scheduleMidnightScan(helper);
  }, delay);
}

function scanForMissedRecurrences(helper) {
  Log.log("Scanning for missed recurring tasks from previous day...");
  
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = getLocalISO(yesterday).slice(0, 10);

  const currentTasks = [...tasks];
  let generatedCount = 0;

  currentTasks.forEach(task => {
    if (!task.deleted && task.recurring && task.recurring !== "none" && task.date === yesterdayStr) {
      const created = generateNextRecurringTask(task);
      if (created) generatedCount++;
    }
  });

  if (generatedCount > 0) {
    Log.log(`Daily Scan: Generated ${generatedCount} new tasks.`);
    broadcastTasks(helper);
  } else {
    Log.log("Daily Scan: No new tasks needed.");
  }
}

function generateNextRecurringTask(task) {
  const nextDate = getNextDate(task.date, task.recurring);
  if (!nextDate) return false;

  const familyRootId = task.rootId || task.id;
  const alreadyExists = tasks.some(t => 
    !t.deleted && 
    t.date === nextDate && 
    t.name === task.name &&
    (t.rootId === familyRootId || t.id === familyRootId)
  );

  if (alreadyExists) return false;

  const newTask = {
    id: Date.now() + Math.floor(Math.random() * 100),
    name: task.name,
    date: nextDate,
    assignedTo: task.assignedTo || null,
    recurring: task.recurring,
    parentId: task.id,
    rootId: familyRootId,
    icon: task.icon,
    reminderTime: task.reminderTime,
    // Order will be recalculated by applyTaskOrder during broadcast
    order: 0, 
    done: false,
    created: getLocalISO(new Date()),
  };
  
  tasks.push(newTask);
  return true;
}

function sendPushover(self, settings, message) {
  const config = self.config || {};
  if (!settings.pushoverEnabled) return;
  if (!config.pushoverApiKey || !config.pushoverUser) {
    Log.error("MMM-Chores: pushoverApiKey and pushoverUser must be set in config.js when Pushover is enabled");
    self.sendSocketNotification(
      "PUSHOVER_CONFIG_ERROR",
      "Please set pushoverApiKey and pushoverUser in config.js to use Pushover notifications."
    );
    return;
  }
  const params = new URLSearchParams({
    token: config.pushoverApiKey,
    user: config.pushoverUser,
    message
  });
  fetchFn("https://api.pushover.net/1/messages.json", {
    method: "POST",
    body: params
  }).catch(err => Log.error("MMM-Chores: Failed to send Pushover notification", err));
}

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    Log.log("loadData: reading", DATA_FILE);
    try {
      const j = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      applyLoadedData(j);
      return;
    } catch (e) {
      Log.error("MMM-Chores: Error reading data.json:", e);
    }
  }

  if (fs.existsSync(DATA_FILE_BAK)) {
    try {
      const backup = JSON.parse(fs.readFileSync(DATA_FILE_BAK, "utf8"));
      applyLoadedData(backup, "data.json.bak");
    } catch (backupErr) {
      Log.error("MMM-Chores: Failed to load backup data file:", backupErr);
    }
  }
}

function saveData() {
  try {
    Log.log("saveData: writing", DATA_FILE);
    const payload = JSON.stringify({ tasks, people, analyticsBoards, settings }, null, 2);
    if (fs.existsSync(DATA_FILE)) {
      try {
        fs.copyFileSync(DATA_FILE, DATA_FILE_BAK);
      } catch (backupErr) {
        Log.error("MMM-Chores: Failed to create backup data file:", backupErr);
      }
    }
    writeDataFileAtomic(DATA_FILE, payload);
    Log.log(
      `MMM-Chores: Saved ${tasks.length} tasks, ${people.length} people, ${analyticsBoards.length} analytics boards, language: ${settings.language}`
    );
    return true;
  } catch (e) {
    Log.error("MMM-Chores: Error writing data.json:", e);
    return false;
  }
}

function runAutoUpdate() {
  Log.log("Auto update: running git pull");
  exec("git pull", { cwd: __dirname }, (err, stdout) => {
    if (err) {
      Log.error("Auto update failed:", err);
    } else {
      Log.log("Auto update output: " + stdout.trim());
      if (!stdout.includes("Already up to date")) {
        Log.log("Auto update applied, reloading module...");
        process.exit(0);
        return;
      } else {
        Log.log("Auto update: already up to date");
      }
    }
    if (settings.autoUpdate) {
      scheduleAutoUpdate();
    }
  });
}

function computeLevel(config, personId = null) {
  const lvlConf = config.leveling || {};
  if (lvlConf.enabled === false) return 1;
  const mode = lvlConf.mode || 'years';
  const max = 100;
  const done = tasks.filter(t => t.done && (!personId || t.assignedTo === personId)).length;
  let totalNeeded;
  if (mode === 'chores') {
    totalNeeded = parseFloat(lvlConf.choresToMaxLevel) || 1;
  } else {
    const years = parseFloat(lvlConf.yearsToMaxLevel) || 1;
    const perW = parseFloat(lvlConf.choresPerWeekEstimate) || 1;
    totalNeeded = years * 52 * perW;
  }
  const tasksPerLvl = totalNeeded / max;
  let lvl = Math.floor(done / tasksPerLvl) + 1;
  if (lvl < 1) lvl = 1;
  if (lvl > max) lvl = max;
  return lvl;
}

function getTitle(config, level, person = null) {
  let arr;
  if (
    person &&
    config.customLevelTitles &&
    Array.isArray(config.customLevelTitles[person.name]) &&
    config.customLevelTitles[person.name].length === 10
  ) {
    arr = config.customLevelTitles[person.name];
  } else if (
    Array.isArray(config.levelTitles) &&
    config.levelTitles.length === 10
  ) {
    arr = config.levelTitles;
  } else {
    arr = DEFAULT_TITLES;
  }
  const idx = Math.floor((level - 1) / 10);
  return arr[idx] || arr[arr.length - 1];
}

function getLevelInfo(config, person = null) {
  const personId = person ? person.id : null;
  const level = computeLevel(config, personId);
  const title = getTitle(config, level, person);
  return { level, title };
}

function updatePeopleLevels(config) {
  people = people.map(p => {
    const info = getLevelInfo(config, p);
    return { ...p, level: info.level, title: info.title };
  });
}

function scanForLatest(taskList) {
  const seriesMap = {};

  // 1. Group by rootId to find the candidate with the furthest date
  taskList.forEach(t => {
    t.isLatest = false; // Default to false
    if (t.deleted) return;

    const root = t.rootId || t.id;
    
    if (!seriesMap[root]) {
      seriesMap[root] = t;
    } else {
      // Compare dates (Strings YYYY-MM-DD compare correctly alphabetically)
      // If dates are equal, use the one with the higher ID (created later)
      if (t.date > seriesMap[root].date) {
        seriesMap[root] = t;
      } else if (t.date === seriesMap[root].date) {
        if (t.id > seriesMap[root].id) {
          seriesMap[root] = t;
        }
      }
    }
  });

  // 2. Mark the winners
  Object.values(seriesMap).forEach(winner => {
    winner.isLatest = true;
  });
  
  return taskList;
}

// FIX: DECIMAL ORDER GENERATION (Rank.YYYYMMDD)
function applyTaskOrder() {
  Log.log(`applyTaskOrder: Calculating decimal orders...`);
  
  // 1. Identify existing family ranks based on current order
  // We scan the array to see the order of unique rootIds
  const rootOrder = [];
  const rootSeen = new Set();
  
  tasks.forEach(t => {
    if (t.deleted) return;
    const root = t.rootId || t.id;
    if (!rootSeen.has(root)) {
      rootSeen.add(root);
      rootOrder.push(root);
    }
  });
  
  // 2. Map rootId -> Integer Rank (0, 1, 2...)
  const rankMap = new Map();
  rootOrder.forEach((root, index) => {
    rankMap.set(root, index);
  });
  
  // 3. Assign Decimal Order: Rank + (DateAsNumber / 100,000,000)
  // Format YYYYMMDD fits into 8 digits. 
  // Rank 5, Date 20251214 => 5.20251214
  
  tasks.forEach(t => {
    if (t.deleted) {
      delete t.order;
      return;
    }
    
    const root = t.rootId || t.id;
    // If a task is not in our seen list (e.g. newly added), put it at the end
    let rank = rankMap.has(root) ? rankMap.get(root) : rootOrder.length;
    
    // Parse date YYYY-MM-DD -> 20251214
    let dateVal = 0;
    if (t.date) {
      const cleanDate = t.date.replace(/-/g, ""); // "2025-12-14" -> "20251214"
      dateVal = parseInt(cleanDate, 10) || 0;
    }
    
    // Calculate final order: Rank + (Date / 100,000,000)
    // We divide by 100M because YYYYMMDD is ~20 million.
    // 20251214 / 100000000 = 0.20251214
    t.order = rank + (dateVal / 100000000);
  });
}

function broadcastTasks(helper) {
  Log.log(`broadcastTasks: start ${tasks.length} tasks`);
  
  // 1. Calculate orders on the real data (we want to persist order)
  applyTaskOrder();
  
  // 2. Create a shallow copy for the Frontend so we don't save 'isLatest' to DB
  let frontendTasks = tasks.map(t => ({ ...t }));
  
  // 3. Run the Scan on the copy
  scanForLatest(frontendTasks);

  // 4. Sort the copy for display
  frontendTasks.sort((a, b) => {
    if (a.deleted && !b.deleted) return 1;
    if (!a.deleted && b.deleted) return -1;
    return (a.order || 0) - (b.order || 0);
  });

  // 5. Analytics only cares about active stuff
  const analyticsData = frontendTasks.filter(t => !(t.deleted && !t.done));

  updatePeopleLevels(helper.config || {});
  
  // Send the PROCESSED tasks (with isLatest) to frontend
  helper.sendSocketNotification("TASKS_UPDATE", frontendTasks);
  helper.sendSocketNotification("CHORES_DATA", analyticsData);
  helper.sendSocketNotification("LEVEL_INFO", getLevelInfo(helper.config || {}));
  helper.sendSocketNotification("PEOPLE_UPDATE", people);
  
  // Save the RAW tasks (without isLatest) to file
  const ok = saveData();
  return ok;
}

function getNextDate(dateStr, recurring) {
  const d = new Date(dateStr);
  if (recurring === "daily") {
    d.setDate(d.getDate() + 1);
  } else if (recurring === "weekly") {
    d.setDate(d.getDate() + 7);
  } else if (recurring === "monthly") {
    d.setMonth(d.getMonth() + 1);
  } else if (recurring === "yearly") {
    d.setFullYear(d.getFullYear() + 1);
  } else {
    return null;
  }
  return d.toISOString().slice(0, 10);
}

module.exports = NodeHelper.create({
  start() {
    Log.log("MMM-Chores helper started...");
    loadData();
    if (settings.autoUpdate) {
      scheduleAutoUpdate();
    }
    scheduleReminder(this);
    
    scanForMissedRecurrences(this);
    scheduleMidnightScan(this);
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "INIT_SERVER") {
      this.config = payload;
      
      // ... (Keep your existing settings configuration logic here) ...
      // (For brevity, I am not pasting the huge settings block, 
      //  but keep the code inside your INIT_SERVER block exactly as it was)
      
      settings = {
        language: settings.language || payload.language,
        dateFormatting: settings.dateFormatting || payload.dateFormatting,
        textMirrorSize: settings.textMirrorSize || payload.textMirrorSize,
        showPast: settings.showPast || payload.showPast,
        showAnalyticsOnMirror: settings.showAnalyticsOnMirror || payload.showAnalyticsOnMirror,
        useAI: settings.useAI || payload.useAI,
        autoUpdate: settings.autoUpdate || payload.autoUpdate,
        pushoverEnabled: settings.pushoverEnabled || payload.pushoverEnabled,
        reminderTime: settings.reminderTime || payload.reminderTime,
        background: settings.background || payload.background || 'forest.png',
        levelingEnabled: settings.levelingEnabled || ((payload.leveling && payload.leveling.enabled) !== false),
        leveling: {
          mode: (settings.leveling && settings.leveling.mode) || (payload.leveling && payload.leveling.mode) || 'years',
          choresToMaxLevel: (settings.leveling && settings.leveling.choresToMaxLevel) || (payload.leveling && payload.leveling.choresToMaxLevel),
          yearsToMaxLevel: (settings.leveling && settings.leveling.yearsToMaxLevel) || (payload.leveling && payload.leveling.yearsToMaxLevel),
          choresPerWeekEstimate: (settings.leveling && settings.leveling.choresPerWeekEstimate) || (payload.leveling && payload.leveling.choresPerWeekEstimate)
        },
        levelTitles: settings.levelTitles || payload.levelTitles,
        customLevelTitles: settings.customLevelTitles || payload.customLevelTitles,
        showTaskDates: (settings.showTaskDates !== undefined) ? settings.showTaskDates : (payload.showTaskDates !== undefined ? payload.showTaskDates : true)
      };

      Object.assign(this.config, settings, {
        leveling: { ...payload.leveling, ...settings.leveling, enabled: settings.levelingEnabled }
      });
      saveData();
      scheduleReminder(this);
      if (!this.server) {
        this.initServer(payload.adminPort);
      } else {
        broadcastTasks(this);
        this.sendSocketNotification("ANALYTICS_UPDATE", analyticsBoards);
        this.sendSocketNotification("SETTINGS_UPDATE", settings);
      }
    }
    
    if (notification === "USER_TOGGLE_CHORE") {
      this.handleUserToggle(payload);
    }

    // --- NEW HANDLER ---
    if (notification === "END_SERIES") {
      const id = parseInt(payload, 10);
      const task = tasks.find(t => t.id === id);
      
      if (task) {
        Log.log(`End Series requested for task: ${task.name} (${id})`);
        
        // Remove the recurrence flag. 
        // This stops generateNextRecurringTask from firing when this task is completed.
        // It effectively turns this specific instance into a one-time task.
        task.recurring = "none";
        
        // Save and update frontend
        saveData();
        broadcastTasks(this); 
      }
    }
  },

  async aiGenerateTasks(req, res) {
    if (!this.config || this.config.useAI === false) {
      return res.status(400).json({
        success: false,
        error: "AI is disabled. Please install the 'openai' npm package and set useAI: true in your config."
      });
    }
    if (!openaiLoaded) {
      return res.status(400).json({
        success: false,
        error: "The 'openai' npm package is not installed. Run 'npm install openai' in the module folder."
      });
    }
    if (!this.config.openaiApiKey) {
      return res.status(400).json({ success: false, error: "OpenAI token missing in config." });
    }

    const completedCount = tasks.filter(t => t.done === true).length;
    const requiredCount = 30;
    if (completedCount < requiredCount) {
      const amountLeft = requiredCount - completedCount;
      return res.status(400).json({
        success: false,
        error: `Too little data. Please complete ${amountLeft} more task${amountLeft > 1 ? "s" : ""} to unlock AI generation.`
      });
    }

    try {
      const openai = new OpenAI({ apiKey: this.config.openaiApiKey });
      const prompt = this.buildPromptFromTasks();

      Log.log("MMM-Chores: Sending prompt to OpenAI...");

      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-nano",
        messages: [
          {
            role: "system",
            content:
              "You are an assistant that, given historical household-task data, creates a schedule for the **next 7 days**.\n" +
              "Return **only** a raw JSON array (no surrounding text). Each item must include:\n" +
              "  • name (string)\n" +
              "  • date (YYYY-MM-DD)\n" +
              "  • assignedTo (person-ID or null)\n" +
              "Rules: Skip done tasks unless recurring. No duplicates on same day. Max 1 big task/person/week. Keep routines."
          },
          { role: "user", content: prompt }
        ],
        max_tokens: 5000,
        temperature: 0.1
      });

      let text = completion.choices[0].message.content;
      text = text.trim();
      if (text.startsWith("```")) {
        text = text.replace(/```[a-z]*\s*([\s\S]*?)\s*```/, "$1").trim();
      }

      const firstBracket = text.indexOf('[');
      const lastBracket  = text.lastIndexOf(']');
      if (firstBracket !== -1 && lastBracket !== -1) {
        text = text.substring(firstBracket, lastBracket + 1);
      }

      let newTasks = [];
      try {
        newTasks = JSON.parse(text);
      } catch (e) {
        Log.error("Failed parsing AI response:", e);
        return res.status(500).json({ success: false, error: "Invalid AI response format.", raw: text });
      }

      const now = new Date();
      let createdCount = 0;

      newTasks.forEach(task => {
        const alreadyExists = tasks.some(t => t.name === task.name && t.date === task.date && !t.deleted);
        if (!alreadyExists) {
          task.id      = Date.now() + Math.floor(Math.random() * 10000);
          task.created = getLocalISO(now);
          task.done    = false;
          if (!task.assignedTo) task.assignedTo = null;
          tasks.push(task);
          createdCount++;
        }
      });

      saveData();
      broadcastTasks(this);
      res.json({ success: true, createdTasks: newTasks, count: createdCount });

    } catch (err) {
      Log.error("AI Generate error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  },

  buildPromptFromTasks() {
    const relevantTasks = tasks.filter(t => t.done === true).map(t => ({
      name:        t.name,
      assignedTo:  t.assignedTo,
      date:        t.date,
      done:        t.done,
      deleted:     t.deleted || false,
      created:     t.created
    }));
    const todayString = new Date().toLocaleDateString("sv-SE", {
      weekday: 'long', year: 'numeric', month: 'numeric', day: 'numeric'
    });
    return JSON.stringify({
      instruction: `Today is ${todayString}. Analyze data, generate tasks for next 7 days. JSON array only.`,
      today: getLocalISO(new Date()).slice(0, 10),
      tasks: relevantTasks,
      people: people
    });
  },

  async handleUserToggle({ id, done }) {
    try {
      const now = new Date();
      const iso = now.toISOString();
      const pad = n => n.toString().padStart(2, "0");
      const stamp = prefix =>
        prefix + pad(now.getMonth() + 1) + pad(now.getDate()) + pad(now.getHours()) + pad(now.getMinutes());

      const body = { done };
      if (done) {
        body.finished = iso;
        body.finishedShort = stamp("F");
      } else {
        body.finished = null;
        body.finishedShort = null;
      }

      const port = this.config.adminPort;
      const headers = { "Content-Type": "application/json" };
      if (this.config.login && this.internalToken) {
        headers["x-auth-token"] = this.internalToken;
      }
      await fetchFn(`http://localhost:${port}/api/tasks/${id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body)
      });

      const getHeaders = {};
      if (this.config.login && this.internalToken) {
        getHeaders["x-auth-token"] = this.internalToken;
      }
      const res = await fetchFn(`http://localhost:${port}/api/tasks`, { headers: getHeaders });
      const latest = await res.json();
      const filtered = latest.filter(t => !(t.deleted && !t.done));
      this.sendSocketNotification("CHORES_DATA", filtered);
    } catch (e) {
      Log.error("MMM-Chores: failed updating task", e);
    }
  },

  initServer(port) {
    if (this.server) return;
    const self = this;
    const app  = express();

    app.use(bodyParser.json());
    app.use(express.static(path.join(__dirname, "public")));
    app.use("/img", express.static(path.join(__dirname, "img")));
    app.use("/MMM-Chores/img", express.static(path.join(__dirname, "img")));

    const users = Array.isArray(self.config.users) ? self.config.users : [];
    if (self.config.login) {
      const token = Math.random().toString(36).slice(2);
      sessions[token] = {
        username: "__internal__",
        permission: "write",
        expires: Infinity
      };
      self.internalToken = token;
    }

    app.post("/api/login", (req, res) => {
      if (!self.config.login) return res.json({ loginRequired: false });
      const { username, password } = req.body;
      const user = users.find(u => u.username === username && u.password === password);
      if (!user) return res.status(401).json({ error: "Invalid credentials" });
      const token = Math.random().toString(36).slice(2);
      sessions[token] = { ...user, expires: Date.now() + SESSION_DURATION_MS };
      res.json({ token, permission: user.permission });
    });

    app.get("/api/login", (req, res) => {
      if (!self.config.login) return res.json({ loginRequired: false });
      const token = req.headers["x-auth-token"];
      const user = sessions[token];
      if (user && user.expires > Date.now()) {
        user.expires = Date.now() + SESSION_DURATION_MS;
        return res.json({ loginRequired: true, loggedIn: true, permission: user.permission });
      }
      if (token && sessions[token]) delete sessions[token];
      res.json({ loginRequired: true, loggedIn: false });
    });

    app.post("/api/logout", (req, res) => {
      if (!self.config.login) return res.json({ success: true });
      const token = req.headers["x-auth-token"];
      if (token && sessions[token]) delete sessions[token];
      res.json({ success: true });
    });

    app.use((req, res, next) => {
      if (!self.config.login) return next();
      if (req.path === "/api/login" || req.path === "/") return next();
      const token = req.headers["x-auth-token"];
      const user = sessions[token];
      if (!user || user.expires <= Date.now()) {
        if (token && sessions[token]) delete sessions[token];
        return res.status(401).json({ error: "Unauthorized" });
      }
      user.expires = Date.now() + SESSION_DURATION_MS;
      req.user = user;
      next();
    });

    function requireWrite(req, res, next) {
      if (!self.config.login) return next();
      if (!req.user || req.user.permission !== "write") {
        return res.status(403).json({ error: "Forbidden" });
      }
      next();
    }

    app.get("/", (req, res) => {
      res.sendFile(path.join(__dirname, "public", "admin.html"));
    });

    app.get("/api/people", (req, res) => res.json(people));
    app.post("/api/people", requireWrite, (req, res) => {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: "Name is required" });
      const id = Date.now();
      const newPersonBase = { id, name };
      const info = getLevelInfo(self.config || {}, newPersonBase);
      const newPerson = { ...newPersonBase, level: info.level, title: info.title };
      people.push(newPerson);
      saveData();
      self.sendSocketNotification("PEOPLE_UPDATE", people);
      res.status(201).json(newPerson);
    });

    app.delete("/api/people/:id", requireWrite, (req, res) => {
      const id = parseInt(req.params.id, 10);
      people = people.filter(p => p.id !== id);
      tasks  = tasks.map(t => t.assignedTo === id ? { ...t, assignedTo: null } : t);
      const success = saveData();
      self.sendSocketNotification("PEOPLE_UPDATE", people);
      broadcastTasks(self);
      res.json({ success });
    });

    app.get("/api/tasks", (req, res) => {
      // Create a copy so we don't modify the persistent array
      let apiTasks = tasks.map(t => ({ ...t }));
      
      // Run the scanner we added earlier to tag isLatest
      scanForLatest(apiTasks);
      
      res.json(apiTasks);
    });

    app.put("/api/tasks/:id/end-series", requireWrite, (req, res) => {
      const id = parseInt(req.params.id, 10);
      const task = tasks.find(t => t.id === id);
      
      if (!task) return res.status(404).json({ error: "Task not found" });

      Log.log(`Admin requested End Series for task: ${task.name} (${id})`);

      // Remove recurrence, effectively making it a one-off task
      task.recurring = "none";
      
      saveData();
      broadcastTasks(self); // Update the mirror immediately
      
      res.json({ success: true, task: task });
    });
    
    app.post("/api/tasks", requireWrite, (req, res) => {
      const now = new Date();
      const generatedId = Date.now();
      const normalize = (str) => (str || "").trim().toLowerCase();
      const newNameNorm = normalize(req.body.name);
      const newAssignee = req.body.assignedTo ? parseInt(req.body.assignedTo, 10) : null;
      let derivedParentId = null;
      let derivedRootId = generatedId;

      if (req.body.parentId) {
        derivedParentId = req.body.parentId;
        const parentTask = tasks.find(t => t.id === derivedParentId);
        if (parentTask) {
          derivedRootId = parentTask.rootId || parentTask.id;
        }
      } else {
        const candidates = tasks.slice().reverse();
        let match = candidates.find(t => 
          normalize(t.name) === newNameNorm && t.assignedTo === newAssignee
        );
        if (!match) {
          match = candidates.find(t => normalize(t.name) === newNameNorm);
        }
        if (match) {
          derivedParentId = match.parentId || match.id;
          derivedRootId = match.rootId || match.id;
        }
      }

      const newTask = {
        id: generatedId,
        ...req.body,
        created: getLocalISO(now),
        // order is calc'd in broadcast
        done: false,
        assignedTo: newAssignee,
        recurring: req.body.recurring || "none",
        parentId: derivedParentId,
        rootId: derivedRootId
      };
      Log.log("POST /api/tasks", newTask);
      
      tasks.push(newTask);
      
      sendPushover(self, settings, `New task: ${newTask.name}`);
      const ok = broadcastTasks(self);
      res.status(ok ? 201 : 500).json(ok ? newTask : { error: "Failed to save data" });
    });

    // FIX: REORDER USING DECIMAL RANKS
    app.put("/api/tasks/reorder", requireWrite, (req, res) => {
      const { ids, movedId } = req.body;
      const idList = Array.isArray(ids) ? ids : (Array.isArray(req.body) ? req.body : []);
      
      if (!idList.length) return res.status(400).json({ error: "Expected task ids" });
      Log.log("PUT /api/tasks/reorder", idList.length, "tasks. Moved:", movedId);

      const taskLookup = new Map();
      tasks.forEach(t => taskLookup.set(t.id, t));

      let activeRootId = null;
      if (movedId) {
        const movedTask = taskLookup.get(movedId);
        if (movedTask) {
          activeRootId = movedTask.rootId || movedTask.id;
        }
      }

      // Determine the NEW order of families (Ranks)
      const newRootOrder = [];
      const seenRoots = new Set();

      idList.forEach(id => {
        const task = taskLookup.get(id);
        if (!task) return;
        const root = task.rootId || task.id;

        // If this is the active moved family, only add it at the dragged position
        if (root === activeRootId) {
          if (id === movedId && !seenRoots.has(root)) {
            newRootOrder.push(root);
            seenRoots.add(root);
          }
        } else {
          // For others, add them first time seen
          if (!seenRoots.has(root)) {
            newRootOrder.push(root);
            seenRoots.add(root);
          }
        }
      });
      
      // Append missing roots
      tasks.forEach(t => {
        const root = t.rootId || t.id;
        if (!seenRoots.has(root)) {
          newRootOrder.push(root);
          seenRoots.add(root);
        }
      });

      // Assign Integer Ranks temporarily to tasks so applyTaskOrder can use them
      // Actually, applyTaskOrder scans unique rootIds from the task array order.
      // So we just need to resort the MAIN tasks array based on this `newRootOrder`.
      
      // 1. Group tasks by root
      const familyMap = new Map();
      tasks.forEach(t => {
        const root = t.rootId || t.id;
        if (!familyMap.has(root)) familyMap.set(root, []);
        familyMap.get(root).push(t);
      });
      
      // 2. Rebuild tasks array in new Family Rank order
      const newTasksList = [];
      newRootOrder.forEach(root => {
        const famTasks = familyMap.get(root) || [];
        famTasks.forEach(t => newTasksList.push(t));
      });
      
      tasks = newTasksList;
      
      // 3. Now broadcastTasks() calls applyTaskOrder() which calculates the decimals
      const ok = broadcastTasks(self);
      res.json({ success: true });
    });

    app.put("/api/tasks/:id", requireWrite, (req, res) => {
      const id   = parseInt(req.params.id, 10);
      const task = tasks.find(t => t.id === id);
      if (!task) return res.status(404).json({ error: "Task not found" });

      const prevDone = task.done;
      Object.entries(req.body).forEach(([key, val]) => {
        if (val === undefined || val === null) delete task[key];
        else task[key] = val;
      });
      Log.log("PUT /api/tasks/" + id, req.body);

      if (!prevDone && task.done && task.recurring && task.recurring !== "none") {
        const created = generateNextRecurringTask(task);
        if (created) Log.log(`Generated recurring task via completion: ${task.name}`);
      }

      const ok = broadcastTasks(self);
      if (!prevDone && task.done) sendPushover(self, settings, `Task completed: ${task.name}`);
      if (!ok) return res.status(500).json({ error: "Failed to save data" });
      res.json(task);
    });

    app.delete("/api/tasks/:id", requireWrite, (req, res) => {
      const id = parseInt(req.params.id, 10);
      const task = tasks.find(t => t.id === id);
      if (!task) return res.status(404).json({ error: "Task not found" });

      if (task.recurring && task.recurring !== "none") {
        const nextDate = getNextDate(task.date, task.recurring);
        if (nextDate) {
           const familyRootId = task.rootId || task.id;
           const successorExists = tasks.some(t => 
             !t.deleted && 
             t.date >= nextDate && 
             (t.rootId === familyRootId || t.id === familyRootId)
           );
           if (!successorExists) {
             Log.log(`Deleting recurring task ${task.id}. Generating next instance to preserve chain.`);
             generateNextRecurringTask(task);
           }
        }
      }

      task.deleted = true;
      Log.log("DELETE /api/tasks/" + id);
      const ok = broadcastTasks(self);
      res.json({ success: ok });
    });


    app.delete("/api/tasks/:id/hard", requireWrite, (req, res) => {
      const id = parseInt(req.params.id, 10);
      const mode = req.query.mode; // Expecting 'single' or 'series'

      const targetTask = tasks.find(t => t.id === id);
      if (!targetTask) return res.status(404).json({ error: "Task not found" });

      const initialLength = tasks.length;

      if (mode === 'series') {
        // Determine the family ID (root)
        const root = targetTask.rootId || targetTask.id;
        
        // Remove ALL tasks that share this root ID (including the root itself)
        tasks = tasks.filter(t => {
          const tRoot = t.rootId || t.id;
          return tRoot !== root;
        });
        
        Log.log(`Hard deleted series (Root: ${root}). Removed ${initialLength - tasks.length} tasks.`);
      } else {
        // Remove ONLY this specific task ID
        tasks = tasks.filter(t => t.id !== id);
        Log.log(`Hard deleted single task: ${id}`);
      }

      // Save and update all clients
      const ok = broadcastTasks(self);
      res.json({ success: ok });
    });

    app.get("/api/analyticsBoards", (req, res) => res.json(analyticsBoards));
    app.post("/api/analyticsBoards", requireWrite, (req, res) => {
      const newBoards = req.body;
      if (!Array.isArray(newBoards)) return res.status(400).json({ error: "Expected array" });
      analyticsBoards = newBoards;
      saveData();
      self.sendSocketNotification("ANALYTICS_UPDATE", analyticsBoards);
      res.json({ success: true, analyticsBoards });
    });

    app.get("/api/settings", (req, res) => {
      const safeSettings = { ...settings };
      delete safeSettings.openaiApiKey;
      delete safeSettings.pushoverApiKey;
      delete safeSettings.pushoverUser;
      res.json({ ...safeSettings, leveling: safeSettings.leveling, settings: self.config.settings });
    });

    app.put("/api/settings", requireWrite, (req, res) => {
      const newSettings = req.body;
      const wasAutoUpdate = settings.autoUpdate;
      if (typeof newSettings !== "object") return res.status(400).json({ error: "Invalid settings" });
      if (newSettings.pushoverEnabled && (!self.config.pushoverApiKey || !self.config.pushoverUser)) {
        return res.status(400).json({ error: "Missing pushover credentials" });
      }
      if (newSettings.leveling) {
        settings.leveling = { ...settings.leveling, ...newSettings.leveling };
        self.config.leveling = { ...self.config.leveling, ...newSettings.leveling };
      }
      Object.entries(newSettings).forEach(([key, val]) => {
        if (key === "leveling" || key === "openaiApiKey" || key === "pushoverApiKey" || key === "pushoverUser") return;
        settings[key] = val;
        if (self.config) {
          if (key === "levelingEnabled") {
            self.config.leveling = self.config.leveling || {};
            self.config.leveling.enabled = val;
          } else {
            self.config[key] = val;
          }
        }
      });
      saveData();
      updatePeopleLevels(self.config);
      self.sendSocketNotification("LEVEL_INFO", getLevelInfo(self.config));
      self.sendSocketNotification("PEOPLE_UPDATE", people);
      self.sendSocketNotification("SETTINGS_UPDATE", settings);
      res.json({ success: true, settings });
      if (newSettings.autoUpdate && !wasAutoUpdate) scheduleAutoUpdate();
      else if (!newSettings.autoUpdate && wasAutoUpdate && autoUpdateTimer) {
        clearTimeout(autoUpdateTimer);
        autoUpdateTimer = null;
      }
      scheduleReminder(self);
    });

    app.post("/api/ai-generate", requireWrite, (req, res) => self.aiGenerateTasks(req, res));

    this.server = app.listen(port, "0.0.0.0", () => {
      Log.log(`MMM-Chores admin (HTTP) running at http://0.0.0.0:${port}`);
      broadcastTasks(self);
      self.sendSocketNotification("PEOPLE_UPDATE", people);
      self.sendSocketNotification("ANALYTICS_UPDATE", analyticsBoards);
      self.sendSocketNotification("SETTINGS_UPDATE", settings);
    });

    const httpsPort = port + 1;
    const keyPath   = path.join(CERT_DIR, "server.key");
    const certPath  = path.join(CERT_DIR, "server.crt");
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      const options = {
        key:  fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
      };
      https.createServer(options, app).listen(httpsPort, "0.0.0.0", () => {
        Log.log(`MMM-Chores admin (HTTPS) running at https://0.0.0.0:${httpsPort}`);
      });
    } else {
      Log.warn("MMM-Chores: HTTPS cert/key not found, skipping HTTPS server");
    }
  }
});