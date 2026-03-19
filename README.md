# ⚡ Raze — Razors Through Workflows

A single-file, full-stack workflow automation engine built with **Node.js**, **Express**, and **MongoDB**. Design multi-step workflows with conditional rule routing, approvals, notifications, and real-time execution tracking — all from a sleek built-in UI.

---

## ✨ Features

- **Visual Workflow Designer** — Create workflows with ordered steps of type `task`, `approval`, or `notification`
- **Rule Engine** — Priority-ordered conditional routing using operators like `==`, `!=`, `>`, `&&`, `||`, `contains()`, `startsWith()`, and a `DEFAULT` fallback
- **Execution Pipeline** — Trigger workflows with dynamic input data and watch each step execute in real-time via a visual flow diagram
- **Multi-step Approvals** — Pause execution at approval steps and resume on approve/reject
- **Input Schema** — Define typed input fields (`string`, `number`, `boolean`) with required flags and allowed value lists
- **Audit Log** — Full execution history with step-level logs and rule evaluation traces
- **Dark / Light Mode** — Fully themed UI with a toggle
- **Skeleton Loaders** — Polished loading states throughout
- **Single File** — The entire backend + frontend lives in one `server.js` file

---

## 🚀 Quick Start (Local)

### Prerequisites

- [Node.js](https://nodejs.org) v18 or higher
- A running MongoDB instance (local or [MongoDB Atlas](https://mongodb.com/atlas))

### Installation

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_USERNAME/raze.git
cd raze

# 2. Install dependencies
npm install

# 3. Start the server
MONGO_URI=mongodb://localhost:27017/raze node server.js
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

The app automatically seeds two sample workflows on first run:
- **Expense Approval** — multi-level approval with conditional routing
- **Employee Onboarding** — notification → task → approval pipeline

---

## ⚙️ Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `MONGO_URI` | `mongodb://localhost:27017/raze` | MongoDB connection string |
| `PORT` | `3000` | Port the server listens on |

---

## 🌐 Free Deployment (No Credit Card)

### Step 1 — MongoDB Atlas (Free M0 Cluster)

1. Sign up at [mongodb.com/atlas](https://mongodb.com/atlas)
2. Create a **free M0 cluster**
3. Add a database user with a username and password
4. Under **Network Access**, add `0.0.0.0/0` to allow all IPs
5. Click **Connect → Drivers** and copy your connection string:
   ```
   mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/raze?retryWrites=true&w=majority
   ```

### Step 2 — Deploy on Render (Free Tier)

1. Push this repo to GitHub
2. Sign up at [render.com](https://render.com) with your GitHub account
3. Click **New → Web Service** and connect your repo
4. Use these settings:

   | Field | Value |
   |---|---|
   | Runtime | Node |
   | Build Command | `npm install` |
   | Start Command | `node server.js` |
   | Instance Type | Free |

5. Under **Environment Variables**, add:
   ```
   MONGO_URI = mongodb+srv://...your atlas URI...
   ```
6. Click **Deploy** — your app will be live at `https://raze-xxxx.onrender.com`

> **Note:** Render's free tier spins down after 15 minutes of inactivity. Use [cron-job.org](https://cron-job.org) (free) to ping your URL every 10 minutes to keep it awake.

---

## 📡 REST API

### Workflows

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/workflows` | List all workflows |
| `POST` | `/api/workflows` | Create a workflow |
| `GET` | `/api/workflows/:id` | Get workflow with steps & rules |
| `PUT` | `/api/workflows/:id` | Update a workflow |
| `DELETE` | `/api/workflows/:id` | Delete workflow and all its steps/rules |

### Steps

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/workflows/:id/steps` | List steps for a workflow |
| `POST` | `/api/workflows/:id/steps` | Add a step |
| `PUT` | `/api/steps/:id` | Update a step |
| `DELETE` | `/api/steps/:id` | Delete a step and its rules |

### Rules

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/steps/:id/rules` | List rules for a step |
| `POST` | `/api/steps/:id/rules` | Add a rule |
| `PUT` | `/api/rules/:id` | Update a rule |
| `DELETE` | `/api/rules/:id` | Delete a rule |

### Executions

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/workflows/:id/execute` | Start a new execution |
| `GET` | `/api/executions` | List all executions |
| `GET` | `/api/executions/:id` | Get execution details with logs |
| `POST` | `/api/executions/:id/cancel` | Cancel an in-progress execution |
| `POST` | `/api/executions/:id/retry` | Retry a failed execution |
| `POST` | `/api/executions/:id/approve` | Approve or reject an approval step |

### Stats

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/stats` | Get workflow and execution counts |

---

## 🧠 Rule Engine

Conditions are evaluated in **priority order** (lowest number = highest priority). The first rule that evaluates to `true` determines the next step.

### Supported Operators

```
==   !=   <   >   <=   >=   &&   ||
contains(field, 'value')
startsWith(field, 'value')
endsWith(field, 'value')
DEFAULT   ← always matches, use as a fallback
```

### Example Rules

```
amount > 100 && country == 'US' && priority == 'High'
amount <= 100 || department == 'HR'
priority == 'Low' && country != 'US'
DEFAULT
```

---

## 🗂️ Project Structure

```
raze/
├── server.js        ← entire app (backend + frontend in one file)
└── package.json
```

---

## 📦 Dependencies

```json
{
  "express": "^4.18.0",
  "mongoose": "^7.0.0",
  "uuid": "^9.0.0"
}
```

---

## 🛠️ Tech Stack

- **Backend** — Node.js, Express, Mongoose
- **Database** — MongoDB
- **Frontend** — Vanilla HTML/CSS/JS (served inline, no build step)
- **Fonts** — Domine, Space Mono, Outfit (Google Fonts)

---

## 📄 License

MIT — free to use, modify, and distribute.

---
