#!/usr/bin/env node
/**
 * Raze — Razors Through Workflows
 * Backend: Express + Mongoose (MongoDB)
 * Frontend: Served inline as HTML string — with SVG icons & visual polish
 *
 * Usage:
 *   npm install express mongoose uuid
 *   MONGO_URI=mongodb://localhost:27017/raze node server.js
 */

const express = require('express');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/raze';
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// MONGOOSE SCHEMAS
// ─────────────────────────────────────────────

const WorkflowSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  name: { type: String, required: true },
  description: String,
  version: { type: Number, default: 1 },
  is_active: { type: Boolean, default: true },
  input_schema: { type: mongoose.Schema.Types.Mixed, default: {} },
  start_step_id: { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const StepSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  workflow_id: { type: String, required: true, index: true },
  name: { type: String, required: true },
  step_type: { type: String, enum: ['task', 'approval', 'notification'], required: true },
  order: { type: Number, default: 0 },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const RuleSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  step_id: { type: String, required: true, index: true },
  condition: { type: String, required: true },
  next_step_id: { type: String, default: null },
  priority: { type: Number, default: 1 },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const StepLogSchema = new mongoose.Schema({
  step_id: String,
  step_name: String,
  step_type: String,
  evaluated_rules: [{ rule: String, result: Boolean }],
  selected_next_step: String,
  status: String,
  approver_id: String,
  error_message: String,
  started_at: String,
  ended_at: String,
}, { _id: false });

const ExecutionSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  workflow_id: { type: String, required: true, index: true },
  workflow_version: Number,
  status: { type: String, enum: ['pending','in_progress','completed','failed','canceled'], default: 'pending' },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  logs: [StepLogSchema],
  current_step_id: { type: String, default: null },
  retries: { type: Number, default: 0 },
  triggered_by: String,
  started_at: String,
  ended_at: { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const Workflow  = mongoose.model('Workflow',  WorkflowSchema);
const Step      = mongoose.model('Step',      StepSchema);
const Rule      = mongoose.model('Rule',      RuleSchema);
const Execution = mongoose.model('Execution', ExecutionSchema);

// ─────────────────────────────────────────────
// RULE ENGINE
// ─────────────────────────────────────────────

function evaluateCondition(condition, data) {
  if (condition.trim().toUpperCase() === 'DEFAULT') return true;
  try {
    // Step 1: Replace string functions first (before any identifier substitution)
    let expr = condition
      .replace(/contains\((\w+),\s*['"](.+?)['"]\)/g, (_,f,v) => `(String(data['${f}']||'').includes('${v}'))`)
      .replace(/startsWith\((\w+),\s*['"](.+?)['"]\)/g, (_,f,v) => `(String(data['${f}']||'').startsWith('${v}'))`)
      .replace(/endsWith\((\w+),\s*['"](.+?)['"]\)/g, (_,f,v) => `(String(data['${f}']||'').endsWith('${v}'))`)
      // Step 2: Replace == with === and != with !== for strict JS equality
      .replace(/([^=!<>])={2}([^=])/g, '$1===$2')
      .replace(/([^!<>=])!={1}([^=])/g, '$1!==$2');

    // Step 3: Replace bare identifiers with data['field'] — but ONLY outside quoted strings
    // Tokenize to skip over quoted string literals entirely
    const reserved = new Set(['true','false','null','undefined','String','Number','Boolean','data']);
    let result = '';
    let i = 0;
    while (i < expr.length) {
      const ch = expr[i];
      // Skip quoted strings verbatim
      if (ch === '"' || ch === "'") {
        const q = ch; let s = ch; i++;
        while (i < expr.length && expr[i] !== q) { s += expr[i]; i++; }
        s += (expr[i] || ''); i++;
        result += s;
        continue;
      }
      // Match identifier
      const identMatch = expr.slice(i).match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
      if (identMatch) {
        const word = identMatch[0];
        const after = expr.slice(i + word.length).trimStart();
        // Don't wrap if reserved, or already part of data[...], or followed by ( (function call)
        if (!reserved.has(word) && expr[i + word.length] !== '(') {
          result += `data['${word}']`;
        } else {
          result += word;
        }
        i += word.length;
        continue;
      }
      result += ch; i++;
    }
    expr = result;

    const fn = new Function('data', `"use strict"; try { return !!(${expr}); } catch(e){ return false; }`);
    return fn(data);
  } catch(e) { return false; }
}

async function advanceExecution(exec) {
  if (exec.status !== 'in_progress' || !exec.current_step_id) return exec;
  const step = await Step.findById(exec.current_step_id);
  if (!step) { exec.status = 'failed'; exec.ended_at = new Date().toISOString(); await exec.save(); return exec; }
  if (step.step_type === 'approval') return exec;

  const rules = await Rule.find({ step_id: step._id }).sort({ priority: 1 });
  const logEntry = {
    step_id: step._id, step_name: step.name, step_type: step.step_type,
    evaluated_rules: [], selected_next_step: null,
    status: 'completed', approver_id: null, error_message: null,
    started_at: new Date().toISOString(), ended_at: null,
  };

  let nextStepId = null, matched = false;
  for (const r of rules) {
    const result = evaluateCondition(r.condition, exec.data);
    logEntry.evaluated_rules.push({ rule: r.condition, result });
    if (!matched && result) {
      nextStepId = r.next_step_id;
      if (nextStepId) {
        const ns = await Step.findById(nextStepId);
        logEntry.selected_next_step = ns?.name || nextStepId;
      } else {
        logEntry.selected_next_step = 'End Workflow';
      }
      matched = true;
    }
  }

  if (!matched && rules.length > 0) {
    logEntry.status = 'failed';
    logEntry.error_message = 'No matching rule found';
  }
  logEntry.ended_at = new Date().toISOString();
  exec.logs.push(logEntry);
  exec.current_step_id = logEntry.status === 'failed' ? null : nextStepId;
  if (logEntry.status === 'failed') { exec.status = 'failed'; exec.ended_at = new Date().toISOString(); }
  else if (!nextStepId) { exec.status = 'completed'; exec.ended_at = new Date().toISOString(); }
  await exec.save();
  if (exec.status === 'in_progress' && exec.current_step_id) return advanceExecution(exec);
  return exec;
}

// ─────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────

app.post('/api/workflows', async (req, res) => {
  try {
    const wf = new Workflow({ _id: uuidv4(), ...req.body });
    await wf.save();
    res.status(201).json(wf);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/workflows', async (req, res) => {
  try {
    const { search = '', status, page = 1, limit = 50 } = req.query;
    const query = {};
    if (search) query.name = { $regex: search, $options: 'i' };
    if (status !== undefined && status !== '') query.is_active = status === 'true';
    const workflows = await Workflow.find(query).sort({ created_at: -1 }).skip((page-1)*limit).limit(Number(limit));
    const total = await Workflow.countDocuments(query);
    const ids = workflows.map(w => w._id);
    const counts = await Step.aggregate([{ $match: { workflow_id: { $in: ids } } }, { $group: { _id: '$workflow_id', count: { $sum: 1 } } }]);
    const countMap = {};
    counts.forEach(c => countMap[c._id] = c.count);
    const data = workflows.map(w => ({ ...w.toObject(), id: w._id, step_count: countMap[w._id] || 0 }));
    res.json({ data, total, page: Number(page) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/workflows/:id', async (req, res) => {
  try {
    const wf = await Workflow.findById(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Not found' });
    const steps = await Step.find({ workflow_id: wf._id }).sort({ order: 1 });
    const stepIds = steps.map(s => s._id);
    const rules = await Rule.find({ step_id: { $in: stepIds } }).sort({ priority: 1 });
    res.json({ ...wf.toObject(), id: wf._id, steps: steps.map(s => ({...s.toObject(),id:s._id})), rules: rules.map(r => ({...r.toObject(),id:r._id})) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/workflows/:id', async (req, res) => {
  try {
    const wf = await Workflow.findById(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Not found' });
    Object.assign(wf, req.body);
    wf.version += 1;
    await wf.save();
    res.json({ ...wf.toObject(), id: wf._id });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/workflows/:id', async (req, res) => {
  try {
    const steps = await Step.find({ workflow_id: req.params.id });
    const stepIds = steps.map(s => s._id);
    await Rule.deleteMany({ step_id: { $in: stepIds } });
    await Step.deleteMany({ workflow_id: req.params.id });
    await Workflow.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/workflows/:workflow_id/steps', async (req, res) => {
  try {
    const wf = await Workflow.findById(req.params.workflow_id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const count = await Step.countDocuments({ workflow_id: wf._id });
    const step = new Step({ _id: uuidv4(), workflow_id: wf._id, order: count + 1, ...req.body });
    await step.save();
    if (!wf.start_step_id) { wf.start_step_id = step._id; await wf.save(); }
    res.status(201).json({ ...step.toObject(), id: step._id });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/workflows/:workflow_id/steps', async (req, res) => {
  try {
    const steps = await Step.find({ workflow_id: req.params.workflow_id }).sort({ order: 1 });
    res.json(steps.map(s => ({ ...s.toObject(), id: s._id })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/steps/:id', async (req, res) => {
  try {
    const step = await Step.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!step) return res.status(404).json({ error: 'Not found' });
    res.json({ ...step.toObject(), id: step._id });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/steps/:id', async (req, res) => {
  try {
    await Rule.deleteMany({ step_id: req.params.id });
    const step = await Step.findByIdAndDelete(req.params.id);
    if (!step) return res.status(404).json({ error: 'Not found' });
    const wf = await Workflow.findById(step.workflow_id);
    if (wf && wf.start_step_id === req.params.id) {
      const first = await Step.findOne({ workflow_id: wf._id }).sort({ order: 1 });
      wf.start_step_id = first ? first._id : null;
      await wf.save();
    }
    res.json({ message: 'Deleted' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/steps/:step_id/rules', async (req, res) => {
  try {
    const rule = new Rule({ _id: uuidv4(), step_id: req.params.step_id, ...req.body });
    await rule.save();
    res.status(201).json({ ...rule.toObject(), id: rule._id });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/steps/:step_id/rules', async (req, res) => {
  try {
    const rules = await Rule.find({ step_id: req.params.step_id }).sort({ priority: 1 });
    res.json(rules.map(r => ({ ...r.toObject(), id: r._id })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/rules/:id', async (req, res) => {
  try {
    const rule = await Rule.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!rule) return res.status(404).json({ error: 'Not found' });
    res.json({ ...rule.toObject(), id: rule._id });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/rules/:id', async (req, res) => {
  try {
    await Rule.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/workflows/:workflow_id/execute', async (req, res) => {
  try {
    const wf = await Workflow.findById(req.params.workflow_id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    if (!wf.start_step_id) return res.status(400).json({ error: 'Workflow has no steps' });
    const exec = new Execution({
      _id: uuidv4(),
      workflow_id: wf._id, workflow_version: wf.version,
      status: 'in_progress', data: req.body.data || {},
      current_step_id: wf.start_step_id,
      triggered_by: req.body.triggered_by || 'user-api',
      started_at: new Date().toISOString(),
    });
    await exec.save();
    const updated = await advanceExecution(exec);
    res.status(201).json({ ...updated.toObject(), id: updated._id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/executions', async (req, res) => {
  try {
    const { search = '', status, page = 1, limit = 50 } = req.query;
    const query = {};
    if (status) query.status = status;
    if (search) {
      const wfs = await Workflow.find({ name: { $regex: search, $options: 'i' } });
      query.workflow_id = { $in: wfs.map(w => w._id) };
    }
    const executions = await Execution.find(query).sort({ created_at: -1 }).skip((page-1)*limit).limit(Number(limit));
    const total = await Execution.countDocuments(query);
    res.json({ data: executions.map(e => ({ ...e.toObject(), id: e._id })), total });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/executions/:id', async (req, res) => {
  try {
    const exec = await Execution.findById(req.params.id);
    if (!exec) return res.status(404).json({ error: 'Not found' });
    res.json({ ...exec.toObject(), id: exec._id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/executions/:id/cancel', async (req, res) => {
  try {
    const exec = await Execution.findById(req.params.id);
    if (!exec) return res.status(404).json({ error: 'Not found' });
    if (!['in_progress','pending'].includes(exec.status)) return res.status(400).json({ error: 'Cannot cancel' });
    exec.status = 'canceled'; exec.ended_at = new Date().toISOString();
    await exec.save();
    res.json({ ...exec.toObject(), id: exec._id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/executions/:id/retry', async (req, res) => {
  try {
    const exec = await Execution.findById(req.params.id);
    if (!exec) return res.status(404).json({ error: 'Not found' });
    if (exec.status !== 'failed') return res.status(400).json({ error: 'Only failed executions can be retried' });
    const failedLog = [...exec.logs].reverse().find(l => l.status === 'failed' || l.status === 'rejected');
    if (!failedLog) return res.status(400).json({ error: 'No failed step found' });
    exec.logs = exec.logs.filter(l => l.step_id !== failedLog.step_id);
    exec.current_step_id = failedLog.step_id;
    exec.status = 'in_progress'; exec.retries += 1; exec.ended_at = null;
    await exec.save();
    const updated = await advanceExecution(exec);
    res.json({ ...updated.toObject(), id: updated._id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/executions/:id/approve', async (req, res) => {
  try {
    const exec = await Execution.findById(req.params.id);
    if (!exec || exec.status !== 'in_progress') return res.status(400).json({ error: 'Execution not in progress' });
    const step = await Step.findById(exec.current_step_id);
    if (!step || step.step_type !== 'approval') return res.status(400).json({ error: 'Current step is not an approval' });
    const { decision, approver_id } = req.body;
    const rules = await Rule.find({ step_id: step._id }).sort({ priority: 1 });
    const logEntry = {
      step_id: step._id, step_name: step.name, step_type: step.step_type,
      evaluated_rules: [], selected_next_step: null,
      status: decision === 'approve' ? 'completed' : 'rejected',
      approver_id: approver_id || 'unknown',
      error_message: decision === 'reject' ? 'Rejected by approver' : null,
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
    };
    if (decision === 'approve') {
      let nextStepId = null, matched = false;
      for (const r of rules) {
        const result = evaluateCondition(r.condition, exec.data);
        logEntry.evaluated_rules.push({ rule: r.condition, result });
        if (!matched && result) {
          nextStepId = r.next_step_id;
          if (nextStepId) { const ns = await Step.findById(nextStepId); logEntry.selected_next_step = ns?.name || nextStepId; }
          else logEntry.selected_next_step = 'End Workflow';
          matched = true;
        }
      }
      exec.logs.push(logEntry);
      exec.current_step_id = nextStepId;
      if (!nextStepId) { exec.status = 'completed'; exec.ended_at = new Date().toISOString(); }
      await exec.save();
      if (exec.status === 'in_progress') await advanceExecution(exec);
    } else {
      exec.logs.push(logEntry);
      exec.status = 'failed'; exec.ended_at = new Date().toISOString(); exec.current_step_id = null;
      await exec.save();
    }
    const fresh = await Execution.findById(exec._id);
    res.json({ ...fresh.toObject(), id: fresh._id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', async (req, res) => {
  try {
    const [workflows, executions, completed, failed] = await Promise.all([
      Workflow.countDocuments(),
      Execution.countDocuments(),
      Execution.countDocuments({ status: 'completed' }),
      Execution.countDocuments({ status: 'failed' }),
    ]);
    res.json({ workflows, executions, completed, failed });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// SEED SAMPLE DATA
// ─────────────────────────────────────────────
async function fixExpenseApprovalRules() {
  try {
    const wf = await Workflow.findOne({ name: 'Expense Approval' });
    if (!wf) return;
    const [s1, s2, s3, s4] = await Promise.all([
      Step.findOne({ workflow_id: wf._id, name: 'Manager Approval' }),
      Step.findOne({ workflow_id: wf._id, name: 'Finance Notification' }),
      Step.findOne({ workflow_id: wf._id, name: 'CEO Approval' }),
      Step.findOne({ workflow_id: wf._id, name: 'Task Rejection' }),
    ]);
    if (!s1 || !s2 || !s3 || !s4) return;

    // Ensure Finance Notification is an approval step so finance can approve/reject
    if (s2.step_type !== 'approval') {
      await Step.findByIdAndUpdate(s2._id, {
        step_type: 'approval',
        metadata: { assignee_email: 'finance@example.com', instructions: 'Finance team review — approve to escalate to CEO or reject.' }
      });
      console.log('✅ Finance Notification upgraded to approval step');
    }

    await Rule.deleteMany({ step_id: { $in: [s1._id, s2._id, s3._id, s4._id] } });
    await Rule.insertMany([
      { _id: require('uuid').v4(), step_id: s1._id, condition: "amount > 100 && country == 'US' && priority == 'High'", next_step_id: s2._id, priority: 1 },
      { _id: require('uuid').v4(), step_id: s1._id, condition: "amount <= 100 || department == 'HR'", next_step_id: s2._id, priority: 2 },
      { _id: require('uuid').v4(), step_id: s1._id, condition: "priority == 'Low' && country != 'US'", next_step_id: s4._id, priority: 3 },
      { _id: require('uuid').v4(), step_id: s1._id, condition: 'DEFAULT', next_step_id: s4._id, priority: 4 },
      { _id: require('uuid').v4(), step_id: s2._id, condition: 'amount > 10000', next_step_id: s3._id, priority: 1 },
      { _id: require('uuid').v4(), step_id: s2._id, condition: 'DEFAULT', next_step_id: s3._id, priority: 2 },
      { _id: require('uuid').v4(), step_id: s3._id, condition: 'DEFAULT', next_step_id: null, priority: 1 },
      { _id: require('uuid').v4(), step_id: s4._id, condition: 'DEFAULT', next_step_id: null, priority: 1 },
    ]);
    console.log('✅ Expense Approval rules fixed');
  } catch(e) { console.log('Migration note:', e.message); }
}

async function seedSampleData() {
  const existing = await Workflow.countDocuments();
  if (existing > 0) { await fixExpenseApprovalRules(); return; }
  console.log('🌱 Seeding sample workflows...');

  const wf1 = new Workflow({
    _id: uuidv4(), name: 'Expense Approval', description: 'Multi-level expense approval process',
    version: 3, is_active: true,
    input_schema: {
      amount: { type: 'number', required: true },
      country: { type: 'string', required: true },
      department: { type: 'string', required: false },
      priority: { type: 'string', required: true, allowed_values: ['High', 'Medium', 'Low'] }
    }
  });
  const s1 = new Step({ _id: uuidv4(), workflow_id: wf1._id, name: 'Manager Approval', step_type: 'approval', order: 1, metadata: { assignee_email: 'manager@example.com', instructions: 'Review and approve or reject the expense.' } });
  const s2 = new Step({ _id: uuidv4(), workflow_id: wf1._id, name: 'Finance Notification', step_type: 'approval', order: 2, metadata: { assignee_email: 'finance@example.com', instructions: 'Finance team review — approve to escalate to CEO or reject.' } });
  const s3 = new Step({ _id: uuidv4(), workflow_id: wf1._id, name: 'CEO Approval', step_type: 'approval', order: 3, metadata: { assignee_email: 'ceo@example.com', instructions: 'Final sign-off for high-value expenses.' } });
  const s4 = new Step({ _id: uuidv4(), workflow_id: wf1._id, name: 'Task Rejection', step_type: 'task', order: 4, metadata: { instructions: 'Log rejection and notify requester.' } });
  wf1.start_step_id = s1._id;
  await wf1.save(); await s1.save(); await s2.save(); await s3.save(); await s4.save();
  await Rule.insertMany([
    { _id: uuidv4(), step_id: s1._id, condition: "amount > 100 && country == 'US' && priority == 'High'", next_step_id: s2._id, priority: 1 },
    { _id: uuidv4(), step_id: s1._id, condition: "amount <= 100 || department == 'HR'", next_step_id: s2._id, priority: 2 },
    { _id: uuidv4(), step_id: s1._id, condition: "priority == 'Low' && country != 'US'", next_step_id: s4._id, priority: 3 },
    { _id: uuidv4(), step_id: s1._id, condition: 'DEFAULT', next_step_id: s4._id, priority: 4 },
    { _id: uuidv4(), step_id: s2._id, condition: 'amount > 10000', next_step_id: s3._id, priority: 1 },
    { _id: uuidv4(), step_id: s2._id, condition: 'DEFAULT', next_step_id: s3._id, priority: 2 },
    { _id: uuidv4(), step_id: s3._id, condition: 'DEFAULT', next_step_id: null, priority: 1 },
    { _id: uuidv4(), step_id: s4._id, condition: 'DEFAULT', next_step_id: null, priority: 1 },
  ]);

  const wf2 = new Workflow({
    _id: uuidv4(), name: 'Employee Onboarding', description: 'New hire onboarding process',
    version: 1, is_active: true,
    input_schema: {
      employee_name: { type: 'string', required: true },
      department: { type: 'string', required: true },
      role: { type: 'string', required: true },
      senior: { type: 'boolean', required: false }
    }
  });
  const t1 = new Step({ _id: uuidv4(), workflow_id: wf2._id, name: 'Send Welcome Email', step_type: 'notification', order: 1, metadata: { notification_channel: 'email' } });
  const t2 = new Step({ _id: uuidv4(), workflow_id: wf2._id, name: 'IT Setup Task', step_type: 'task', order: 2, metadata: { instructions: 'Provision accounts and laptop.' } });
  const t3 = new Step({ _id: uuidv4(), workflow_id: wf2._id, name: 'HR Manager Approval', step_type: 'approval', order: 3, metadata: { assignee_email: 'hr@example.com' } });
  wf2.start_step_id = t1._id;
  await wf2.save(); await t1.save(); await t2.save(); await t3.save();
  await Rule.insertMany([
    { _id: uuidv4(), step_id: t1._id, condition: 'DEFAULT', next_step_id: t2._id, priority: 1 },
    { _id: uuidv4(), step_id: t2._id, condition: 'DEFAULT', next_step_id: t3._id, priority: 1 },
    { _id: uuidv4(), step_id: t3._id, condition: 'DEFAULT', next_step_id: null, priority: 1 },
  ]);
  console.log('✅ Sample data seeded.');
}

// ─────────────────────────────────────────────
// FRONTEND HTML — Enhanced with SVG Icons
// ─────────────────────────────────────────────
const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Raze — Razors Through Workflows</title>
<link href="https://fonts.googleapis.com/css2?family=Domine:wght@400;500;600;700&family=Space+Mono:ital,wght@0,400;0,700;1,400&family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
/* ── DESIGN TOKENS — Jet Black × Silver Beige × Mustard Yellow ── */
:root {
  /* Backgrounds — silver beige tones */
  --bg-0: #EDEAE5;
  --bg-1: #F5F2EE;
  --bg-2: #E4DFD8;
  --bg-3: #D9D3CB;
  --bg-4: #CCC5BC;

  /* Mustard accent */
  --mustard: #F2D04E;
  --mustard-dim: rgba(242,208,78,.15);
  --mustard-glow: rgba(242,208,78,.4);
  --mustard-mid: rgba(242,208,78,.6);
  --mustard-muted: rgba(242,208,78,.35);

  /* Jet Black brand */
  --jet: #24221B;
  --jet-dim: rgba(36,34,27,.08);
  --jet-glow: rgba(36,34,27,.2);
  --jet-mid: rgba(36,34,27,.45);
  --jet-muted: rgba(36,34,27,.28);

  /* Alias slate → jet for structural references */
  --slate: #24221B;
  --slate-dim: rgba(36,34,27,.08);
  --slate-glow: rgba(36,34,27,.2);
  --slate-mid: rgba(36,34,27,.45);
  --slate-muted: rgba(36,34,27,.28);

  /* Keep green alias → mustard for highlights */
  --green: #F2D04E;
  --green-dim: rgba(242,208,78,.15);
  --green-glow: rgba(242,208,78,.4);
  --green-mid: rgba(242,208,78,.6);
  --green-muted: rgba(242,208,78,.35);

  /* Text — jet on silver */
  --text-0: #24221B;
  --text-1: #3A3830;
  --text-2: #7A7568;
  --text-3: #AAA49A;

  /* Borders */
  --border-0: rgba(36,34,27,.1);
  --border-1: rgba(36,34,27,.18);
  --border-green: rgba(242,208,78,.5);

  /* Semantic colors */
  --red: #C0392B;
  --red-dim: rgba(192,57,43,.1);
  --amber: #E09B20;
  --amber-dim: rgba(224,155,32,.12);
  --blue: #2E6DA4;
  --blue-dim: rgba(46,109,164,.1);

  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-xl: 18px;

  --font-ui: 'Outfit', sans-serif;
  --font-mono: 'Space Mono', monospace;
  --font-display: 'Domine', serif;

  --shadow-sm: 0 1px 4px rgba(36,34,27,.1);
  --shadow-md: 0 4px 16px rgba(36,34,27,.15);
  --shadow-lg: 0 12px 40px rgba(36,34,27,.22);
  --shadow-green: 0 0 24px rgba(242,208,78,.3);
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { font-size: 15px; }


/* ══ DARK MODE DROPDOWN / SELECT / INPUT FIX ══ */
body.dark select,
body.dark textarea {
  background-color: #2E2C22 !important;
  color: #FFFFFF !important;
  border-color: rgba(228,223,216,.2) !important;
  color-scheme: dark !important;
}
body.dark select option {
  background-color: #2E2C22 !important;
  background: #2E2C22 !important;
  color: #FFFFFF !important;
}
body.dark select option:checked {
  background-color: #3E3C2E !important;
  color: #F2D04E !important;
}
body.dark select:focus,
body.dark textarea:focus {
  border-color: rgba(242,208,78,.5) !important;
  box-shadow: 0 0 0 3px rgba(242,208,78,.1) !important;
  outline: none !important;
}
body.dark input::placeholder,
body.dark textarea::placeholder {
  color: rgba(228,223,216,.3) !important;
}
/* Ensure all selects use dark scheme so OS renders dark dropdown */
body.dark * { color-scheme: dark; }
body.dark .sidebar,
body.dark .sidebar * { color-scheme: light; }


/* ══════════════════════════════════════
   HIGH-CONTRAST TABLE OVERRIDE
══════════════════════════════════════ */
table { border-collapse: collapse; width: 100%; }

thead tr {
  background: #2A2820 !important;
}
thead th {
  background: #2A2820 !important;
  color: #F2D04E !important;
  font-size: .75rem !important;
  font-weight: 700 !important;
  letter-spacing: 2px !important;
  text-transform: uppercase !important;
  padding: 14px 16px !important;
  font-family: var(--font-display) !important;
  border-bottom: 2px solid #F2D04E !important;
  border-right: none !important;
}
thead th:first-child { border-radius: 8px 0 0 0; }
thead th:last-child  { border-radius: 0 8px 0 0; }

tbody tr {
  background: rgba(255,255,255,.55) !important;
  border-bottom: 1px solid rgba(36,34,27,.12) !important;
  transition: all .15s ease !important;
}
tbody tr:nth-child(even) {
  background: rgba(228,220,210,.45) !important;
}
tbody tr:hover {
  background: rgba(242,208,78,.14) !important;
  transform: translateX(3px) !important;
  box-shadow: inset 3px 0 0 #F2D04E !important;
}
tbody td {
  padding: 14px 16px !important;
  font-size: .92rem !important;
  color: #1A1812 !important;
  font-weight: 600 !important;
  vertical-align: middle !important;
  border: none !important;
}

/* UUID cells */
tbody td .uuid-cell,
.uuid-cell {
  font-family: var(--font-mono) !important;
  font-size: .74rem !important;
  color: #4A4438 !important;
  font-weight: 700 !important;
  background: rgba(36,34,27,.07) !important;
  padding: 2px 7px !important;
  border-radius: 4px !important;
  display: inline-block !important;
}

/* Workflow name bold */
tbody td span[style*="font-weight:700"],
tbody td div[style*="font-weight:700"] {
  color: #1A1812 !important;
  font-size: .88rem !important;
}

/* Version chips */
tbody td[style*="font-family:var(--font-mono)"] {
  color: #3A3428 !important;
  font-weight: 700 !important;
}

/* Warm grain texture overlay */
body::after {
  content: "";
  position: fixed; inset: 0;
  pointer-events: none;
  z-index: 9998;
  opacity: .018;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
  background-size: 200px 200px;
}
body {
  font-family: var(--font-ui);
  background: var(--bg-0);
  color: var(--text-0);
  min-height: 100vh;
  display: flex;
  overflow: auto;
}

::-webkit-scrollbar { width: 4px; height: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--bg-3); border-radius: 2px; }
::-webkit-scrollbar-thumb:hover { background: var(--jet-mid); }

/* ── SVG ICON SYSTEM ── */
.icon-svg {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.icon-svg svg {
  width: 100%;
  height: 100%;
}

/* ── SIDEBAR ── */
.sidebar {
  width: 224px;
  min-width: 224px;
  background: var(--jet);
  border-right: 1px solid var(--border-0);
  display: flex;
  flex-direction: column;
  z-index: 10;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
}

.sidebar::after {
  content: '';
  position: absolute;
  top: 0; right: 0;
  width: 1px; height: 100%;
  background: linear-gradient(180deg, transparent, rgba(242,208,78,.25) 40%, transparent);
  pointer-events: none;
}

.sidebar-logo {
  padding: 22px 20px 18px;
  border-bottom: 1px solid rgba(242,208,78,.2);
  margin-bottom: 6px;
}

/* ── ANIMATED LOGO MARK ── */
.logo-mark {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}

.logo-hex {
  width: 34px;
  height: 34px;
  position: relative;
  flex-shrink: 0;
}

.logo-hex svg {
  width: 34px;
  height: 34px;
  animation: hex-spin 8s linear infinite;
}

@keyframes hex-spin {
  0%   { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.logo-hex-inner {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.logo-hex-inner svg {
  width: 14px;
  height: 14px;
  animation: none;
}

.brand {
  font-family: var(--font-display);
  font-size: 1.3rem;
  font-weight: 700;
  color: #E4DFD8;
  letter-spacing: -0.5px;
}

.brand span { color: var(--green); }

.tagline {
  font-size: .65rem;
  font-weight: 500;
  color: rgba(242,208,78,.45);
  letter-spacing: 2.5px;
  text-transform: uppercase;
  font-family: var(--font-mono);
}

.nav-section {
  padding: 14px 20px 5px;
  font-size: .62rem;
  font-weight: 600;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: rgba(242,208,78,.35);
  font-family: var(--font-display);
  font-size: .63rem;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 20px;
  cursor: pointer;
  color: rgba(228,223,216,.82);
  font-size: .9rem;
  font-weight: 600;
  font-family: var(--font-display);
  border-left: 2px solid transparent;
  transition: all .18s ease;
  user-select: none;
}

.nav-item:hover { color: #E4DFD8; background: rgba(242,208,78,.08); }
.nav-item.active { color: var(--mustard); border-left-color: var(--mustard); background: rgba(242,208,78,.12); font-weight: 700; }

.nav-icon {
  width: 18px; height: 18px;
  display: flex; align-items: center; justify-content: center;
  opacity: .7; flex-shrink: 0;
  transition: opacity .18s;
}
.nav-item:hover .nav-icon,
.nav-item.active .nav-icon { opacity: 1; }

/* Color the nav SVGs */
.nav-item svg { color: currentColor; }

.sidebar-footer {
  margin-top: auto;
  padding: 14px 16px;
  border-top: 1px solid rgba(242,208,78,.15);
}

/* ── RAZE ANIMATED FOOTER WIDGET ── */
.raze-widget {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 12px 10px 10px;
  background: rgba(242,208,78,.06);
  border-radius: var(--radius-md);
  border: 1px solid rgba(242,208,78,.15);
  position: relative;
  overflow: hidden;
}

.raze-widget::before {
  content: '';
  position: absolute;
  bottom: 0; left: -60%;
  width: 60%; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(242,208,78,.6), transparent);
  animation: raze-scan 3s ease-in-out infinite;
}

@keyframes raze-scan {
  0%   { left: -60%; opacity: 0; }
  20%  { opacity: 1; }
  80%  { opacity: 1; }
  100% { left: 110%; opacity: 0; }
}

.raze-bolt-wrap {
  position: relative;
  width: 42px; height: 42px;
  display: flex; align-items: center; justify-content: center;
}

.raze-bolt-ring {
  position: absolute; inset: 0;
  border-radius: 50%;
  border: 1.5px solid rgba(242,208,78,.25);
  animation: raze-ring-spin 6s linear infinite;
}

.raze-bolt-ring::before {
  content: '';
  position: absolute;
  top: -2px; left: 50%; transform: translateX(-50%);
  width: 5px; height: 5px;
  background: var(--mustard);
  border-radius: 50%;
  box-shadow: 0 0 6px var(--mustard);
}

@keyframes raze-ring-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

.raze-bolt-core {
  position: relative; z-index: 1;
  width: 28px; height: 28px;
  background: rgba(242,208,78,.12);
  border: 1px solid rgba(242,208,78,.3);
  border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  animation: raze-bolt-pulse 2s ease-in-out infinite;
}

@keyframes raze-bolt-pulse {
  0%, 100% { box-shadow: 0 0 6px rgba(242,208,78,.3); }
  50%       { box-shadow: 0 0 14px rgba(242,208,78,.6), 0 0 28px rgba(242,208,78,.2); }
}

.raze-particles {
  position: absolute; inset: 0; pointer-events: none;
}

.raze-p {
  position: absolute;
  width: 2px; height: 2px;
  background: var(--mustard);
  border-radius: 50%;
  opacity: 0;
}

.raze-p:nth-child(1) { top: 20%; left: 10%; animation: raze-float 3.2s 0s ease-in-out infinite; }
.raze-p:nth-child(2) { top: 70%; left: 80%; animation: raze-float 2.8s .6s ease-in-out infinite; }
.raze-p:nth-child(3) { top: 40%; left: 90%; animation: raze-float 3.5s 1.2s ease-in-out infinite; }
.raze-p:nth-child(4) { top: 80%; left: 20%; animation: raze-float 2.5s 1.8s ease-in-out infinite; }
.raze-p:nth-child(5) { top: 15%; left: 60%; animation: raze-float 3.8s 0.4s ease-in-out infinite; }

@keyframes raze-float {
  0%   { opacity: 0; transform: translateY(0) scale(1); }
  30%  { opacity: .9; }
  70%  { opacity: .5; }
  100% { opacity: 0; transform: translateY(-12px) scale(0.4); }
}

.raze-wordmark {
  font-family: var(--font-display);
  font-size: .82rem;
  font-weight: 700;
  color: rgba(228,223,216,.7);
  letter-spacing: 3px;
  text-transform: uppercase;
}

.raze-wordmark span { color: var(--mustard); }

.raze-tagline {
  font-family: var(--font-mono);
  font-size: .6rem;
  color: rgba(228,223,216,.3);
  letter-spacing: 1.5px;
  text-transform: uppercase;
}

/* ── OLD DB INDICATOR (kept for compat, hidden) ── */
.db-indicator { display: none; }
.db-dot { display: none; }
.db-label { display: none; }
.db-version { display: none; }

/* ── RAZE WIDGET LIGHT MODE (sidebar is dark jet, so these are already bright) ── */
/* Light mode sidebar IS dark, so the default styles above are fine.             */
/* Dark mode flips the sidebar to light beige #E4DFD8 — need dark contrast.     */
body.dark .raze-widget {
  background: rgba(36,34,27,.1) !important;
  border-color: rgba(184,144,10,.5) !important;
  box-shadow: 0 2px 12px rgba(36,34,27,.08);
}

body.dark .raze-widget::before {
  background: linear-gradient(90deg, transparent, rgba(184,144,10,.8), transparent) !important;
}

body.dark .raze-bolt-ring {
  border-color: rgba(184,144,10,.5) !important;
}

body.dark .raze-bolt-ring::before {
  background: #B8900A !important;
  box-shadow: 0 0 6px rgba(184,144,10,.8) !important;
}

body.dark .raze-bolt-core {
  background: rgba(184,144,10,.18) !important;
  border-color: rgba(184,144,10,.6) !important;
}

body.dark .raze-bolt-core svg polyline {
  stroke: #B8900A !important;
  fill: rgba(184,144,10,.3) !important;
}

body.dark .raze-wordmark {
  color: #24221B !important;
  text-shadow: none;
  font-weight: 800 !important;
}

body.dark .raze-wordmark span {
  color: #B8900A !important;
}

body.dark .raze-tagline {
  color: rgba(36,34,27,.5) !important;
}

body.dark .raze-p {
  background: #B8900A !important;
}

/* ── MAIN LAYOUT ── */
.main {
  flex: 1; display: flex; flex-direction: column; overflow: auto;
  background:
    radial-gradient(ellipse 80% 50% at 90% 0%, rgba(242,208,78,.13) 0%, transparent 60%),
    radial-gradient(ellipse 60% 40% at 0% 100%, rgba(242,208,78,.09) 0%, transparent 55%),
    radial-gradient(ellipse 50% 60% at 50% 50%, rgba(228,223,216,.6) 0%, transparent 80%),
    linear-gradient(160deg, #F5F2EE 0%, #EDE8E1 40%, #E8E2D9 100%);
}

/* ── TOPBAR ── */
.topbar {
  background: var(--slate);
  border-bottom: 1px solid rgba(255,255,255,.1);
  padding: 0 28px;
  height: 54px;
  display: flex; align-items: center; justify-content: space-between;
  flex-shrink: 0;
  position: sticky;
  top: 0;
  z-index: 9;
}

.topbar-left { display: flex; align-items: center; gap: 10px; }

.topbar-icon {
  width: 26px; height: 26px;
  background: rgba(242,208,78,.15);
  border: 1px solid rgba(242,208,78,.3);
  border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  color: var(--mustard);
}

.topbar-title {
  font-size: 1rem;
  font-weight: 600;
  color: rgba(228,223,216,.92);
  font-family: var(--font-display);
  letter-spacing: .3px;
}
.topbar-title span { color: var(--mustard); }

.topbar-right { display: flex; align-items: center; gap: 12px; }

.topbar-time {
  font-size: .78rem;
  font-family: var(--font-mono);
  color: rgba(228,223,216,.65);
}

/* ── PAGES ── */
.page {
  display: none; flex: 1; overflow-y: auto;
  padding: 22px 28px;
  flex-direction: column; gap: 16px;
  background: transparent;
}
.page.active { display: flex; }

/* ── CARDS ── */
.card {
  background: rgba(245,242,238,.88);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border-radius: var(--radius-lg);
  border: 1px solid rgba(242,208,78,.15);
  padding: 20px;
  transition: border-color .25s, box-shadow .25s, background .25s;
  box-shadow: 0 1px 3px rgba(36,34,27,.06), 0 4px 16px rgba(36,34,27,.06);
}
.card:hover {
  border-color: rgba(242,208,78,.35);
  background: rgba(248,245,241,.95);
  box-shadow: 0 2px 8px rgba(36,34,27,.08), 0 8px 24px rgba(242,208,78,.08);
}

.card-title {
  font-size: .85rem;
  font-weight: 700;
  color: var(--text-2);
  text-transform: uppercase;
  letter-spacing: 1.5px;
  font-family: var(--font-display);
  color: #3A3830;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.card-title-icon {
  width: 20px; height: 20px;
  background: var(--mustard-dim);
  border-radius: 5px;
  display: flex; align-items: center; justify-content: center;
  color: var(--jet);
  flex-shrink: 0;
}

/* ── BUTTONS ── */
.btn {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 9px 18px;
  border-radius: var(--radius-sm);
  font-family: var(--font-display);
  font-size: .9rem; font-weight: 600;
  cursor: pointer; border: none;
  transition: all .18s ease;
  white-space: nowrap;
}

.btn-primary { background: var(--mustard); color: var(--jet); font-weight: 700; }
.btn-primary:hover { background: #F5D94A; transform: translateY(-1px); box-shadow: 0 4px 20px var(--mustard-glow); }

.btn-ghost { background: transparent; color: var(--text-1); border: 1px solid var(--border-1); }
.btn-ghost:hover { background: var(--bg-2); color: var(--jet); border-color: var(--jet-mid); }

.btn-danger { background: var(--red-dim); color: var(--red); border: 1px solid rgba(255,95,95,.2); }
.btn-danger:hover { background: rgba(255,95,95,.2); }

.btn-sm { padding: 8px 16px; font-size: .88rem; }
.btn-xs { padding: 6px 13px; font-size: .83rem; border-radius: 5px; }

/* ── STAT CARDS ── */
.stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }

.stat-card {
  background: linear-gradient(135deg, rgba(245,242,238,.95) 0%, rgba(237,232,225,.85) 100%);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border-radius: var(--radius-lg);
  padding: 18px;
  border: 1px solid rgba(242,208,78,.18);
  position: relative; overflow: hidden;
  transition: border-color .2s, transform .2s, box-shadow .2s;
  cursor: default;
  box-shadow: 0 1px 3px rgba(36,34,27,.07), 0 4px 12px rgba(36,34,27,.06);
}

.stat-card::after {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(242,208,78,.5), transparent); transition: none;
  pointer-events: none;
}
.stat-card:hover {
  border-color: rgba(242,208,78,.5);
  transform: translateY(-2px);
  box-shadow: 0 4px 20px rgba(242,208,78,.12), 0 8px 32px rgba(36,34,27,.1);
  background: linear-gradient(135deg, rgba(248,245,241,.98) 0%, rgba(242,237,230,.9) 100%);
}

.stat-card-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 12px; }

.stat-icon-wrap {
  width: 38px; height: 38px;
  border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}

.stat-icon-wrap.green { background: var(--mustard-dim); border: 1px solid rgba(242,208,78,.4); color: var(--jet); }
.stat-icon-wrap.blue { background: var(--blue-dim); border: 1px solid rgba(100,181,246,.2); color: var(--blue); }
.stat-icon-wrap.amber { background: var(--amber-dim); border: 1px solid rgba(255,179,71,.2); color: var(--amber); }
.stat-icon-wrap.red { background: var(--red-dim); border: 1px solid rgba(255,95,95,.2); color: var(--red); }

.stat-trend {
  font-size: .65rem;
  font-family: var(--font-mono);
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 600;
}
.stat-trend.up { background: var(--mustard-dim); color: var(--jet); border: 1px solid rgba(242,208,78,.35); }
.stat-trend.neutral { background: var(--bg-3); color: var(--text-2); }

.stat-label {
  font-size: .74rem; font-weight: 700; color: #5A5548;
  text-transform: uppercase; letter-spacing: 1.5px;
  font-family: var(--font-display); margin-bottom: 4px;
}

.stat-value {
  font-family: var(--font-display); font-size: 2.4rem; font-weight: 700;
  color: #24221B; line-height: 1; letter-spacing: -1.5px;
}

.stat-value.green { color: var(--jet); text-shadow: none; }
.stat-value.red { color: var(--red); }
.stat-value.blue { color: var(--blue); }

/* ── SKELETON LOADERS ── */
@keyframes shimmer {
  0% { background-position: -400px 0; }
  100% { background-position: 400px 0; }
}
.skeleton {
  background: linear-gradient(90deg, var(--bg-2) 25%, var(--bg-3) 50%, var(--bg-2) 75%); /* oatmilk shimmer */
  background-size: 800px 100%;
  animation: shimmer 1.4s ease-in-out infinite;
  border-radius: var(--radius-sm);
}
.skel-stat { height: 100px; border-radius: var(--radius-lg); }
.skel-row { height: 40px; margin-bottom: 8px; }

/* ── INPUTS ── */
.input-wrap { position: relative; flex: 1; }
.input-wrap input, .input-wrap select {
  width: 100%; padding: 8px 12px 8px 34px;
  border: 1px solid rgba(36,34,27,.2); border-radius: var(--radius-sm);
  font-family: var(--font-mono); font-size: .8rem;
  background: rgba(255,255,255,.7); color: #24221B; outline: none;
  transition: all .18s;
}
.input-wrap input:focus, .input-wrap select:focus {
  border-color: var(--mustard); background: var(--bg-1);
  box-shadow: 0 0 0 3px var(--mustard-dim);
}
.input-wrap .icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--text-2); display: flex; align-items: center; }

.form-row { display: flex; flex-direction: column; gap: 5px; margin-bottom: 14px; }
.form-label { font-size: .78rem; font-weight: 700; color: #4A4740; letter-spacing: 1px; text-transform: uppercase; font-family: var(--font-display); }
.form-input {
  padding: 9px 13px; border: 1px solid rgba(36,34,27,.2); border-radius: var(--radius-sm);
  font-family: var(--font-mono); font-size: .88rem;
  background: rgba(255,255,255,.7); color: #24221B; outline: none; transition: all .18s; width: 100%;
}
.form-input:focus { border-color: var(--mustard); background: var(--bg-1); box-shadow: 0 0 0 3px var(--mustard-dim); }
textarea.form-input { resize: vertical; min-height: 80px; }
.form-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-hint { font-size: .76rem; color: #6A6558; margin-top: 3px; font-family: var(--font-mono); font-weight: 600; }

/* ── TABLES ── */
table { width: 100%; border-collapse: collapse; }
thead th {
  background: linear-gradient(90deg, rgba(217,210,200,.85), rgba(210,203,193,.8));
  color: #3A3830;
  font-size: .68rem; font-weight: 700; letter-spacing: 2px; text-transform: uppercase;
  padding: 11px 14px; text-align: left; border-bottom: 1px solid rgba(36,34,27,.15);
  font-family: var(--font-display);
}
tbody tr { border-bottom: 1px solid var(--border-0); transition: .18s; }
tbody tr:hover { background: rgba(242,208,78,.06) !important; transform: translateX(2px); }
tbody td { padding: 12px 14px; font-size: .84rem; vertical-align: middle; color: #2A2820; font-weight: 500; }

/* ── BADGES ── */
.badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 10px; border-radius: 4px;
  font-size: .72rem; font-weight: 600; letter-spacing: .5px;
  text-transform: uppercase; font-family: var(--font-mono);
}
.badge::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: .7; }

.badge-active { background: var(--mustard-dim); color: var(--jet); border: 1px solid rgba(242,208,78,.4); }
.badge-inactive { background: var(--red-dim); color: var(--red); border: 1px solid rgba(255,95,95,.2); }
.badge-pending { background: var(--amber-dim); color: var(--amber); border: 1px solid rgba(255,179,71,.2); }
.badge-completed { background: var(--mustard-dim); color: var(--jet); border: 1px solid rgba(242,208,78,.4); }
.badge-failed { background: var(--red-dim); color: var(--red); border: 1px solid rgba(255,95,95,.2); }
.badge-in_progress { background: var(--blue-dim); color: var(--blue); border: 1px solid rgba(100,181,246,.2); }
.badge-canceled { background: var(--bg-3); color: var(--text-2); border: 1px solid var(--border-0); }
.badge-rejected { background: var(--red-dim); color: var(--red); border: 1px solid rgba(255,95,95,.2); }
.badge-task { background: var(--amber-dim); color: var(--amber); border: 1px solid rgba(255,179,71,.2); }
.badge-approval { background: var(--blue-dim); color: var(--blue); border: 1px solid rgba(100,181,246,.2); }
.badge-notification { background: rgba(160,110,255,.12); color: #b494ff; border: 1px solid rgba(160,110,255,.2); }

.actions-cell { display: flex; gap: 6px; flex-wrap: wrap; }
.uuid-cell { font-family: var(--font-mono); font-size: .72rem; color: #7A7568; max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }

/* ── TOGGLE ── */
.toggle { width: 36px; height: 20px; background: var(--bg-4); border-radius: 20px; position: relative; cursor: pointer; transition: .3s; border: 1px solid var(--border-1); flex-shrink: 0; }
.toggle.on { background: var(--mustard); border-color: var(--mustard); box-shadow: 0 0 8px var(--mustard-glow); }
.toggle::after { content: ''; position: absolute; left: 3px; top: 3px; width: 12px; height: 12px; border-radius: 50%; background: var(--text-1); transition: .3s; }
.toggle.on::after { left: 19px; background: var(--jet); }

/* ── MODALS ── */
.modal-overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(36,34,27,.6); display: flex; align-items: center; justify-content: center; backdrop-filter: blur(12px); opacity: 0; pointer-events: none; transition: opacity .2s; }
.modal-overlay.open { opacity: 1; pointer-events: all; }
.modal { background: linear-gradient(145deg, rgba(248,245,241,.98) 0%, rgba(242,237,230,.96) 100%); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border-radius: var(--radius-xl); box-shadow: 0 20px 60px rgba(36,34,27,.2), 0 0 0 1px rgba(242,208,78,.12); border: 1px solid rgba(242,208,78,.2); width: 520px; max-width: 95vw; max-height: 90vh; overflow-y: auto; padding: 24px; transform: translateY(16px) scale(.98); transition: transform .22s; }
.modal-overlay.open .modal { transform: translateY(0) scale(1); }
.modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; padding-bottom: 14px; border-bottom: 1px solid var(--border-0); gap: 12px; }
.modal-title-wrap { display: flex; align-items: center; gap: 10px; }
.modal-title-icon { width: 32px; height: 32px; background: var(--slate-dim); border: 1px solid var(--slate-muted); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--slate); }
.modal-title { font-size: 1.05rem; font-weight: 700; color: var(--text-0); font-family: var(--font-display); }
.modal-close { background: var(--bg-3); border: 1px solid var(--border-1); border-radius: 50%; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--text-1); font-size: .9rem; transition: .18s; }
.modal-close:hover { background: var(--bg-4); color: var(--text-0); }
.modal-footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--border-0); }

/* ── STEP CARDS ── */
.step-card { background: linear-gradient(120deg, rgba(242,237,230,.9), rgba(237,232,225,.85)); border: 1px solid rgba(36,34,27,.09); border-radius: var(--radius-md); padding: 12px 14px; display: flex; align-items: center; gap: 12px; margin-bottom: 6px; transition: all .18s; }
.step-card:hover { border-color: var(--mustard); box-shadow: 0 2px 14px var(--mustard-dim); }
.step-order { width: 28px; height: 28px; background: var(--mustard); border: 1px solid var(--mustard); color: var(--jet); border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: .8rem; font-weight: 700; font-family: var(--font-mono); flex-shrink: 0; }
.step-info { flex: 1; }
.step-name { font-weight: 700; font-size: .94rem; font-family: var(--font-display); color: #24221B; }

/* ── STEP TYPE ICONS ── */
.step-type-icon {
  width: 32px; height: 32px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.step-type-icon.task { background: var(--amber-dim); border: 1px solid rgba(255,179,71,.2); color: var(--amber); }
.step-type-icon.approval { background: var(--blue-dim); border: 1px solid rgba(100,181,246,.2); color: var(--blue); }
.step-type-icon.notification { background: rgba(160,110,255,.12); border: 1px solid rgba(160,110,255,.2); color: #b494ff; }

/* ── RULE ROWS ── */
.rule-row { display: grid; grid-template-columns: 42px 1fr 160px 72px; gap: 8px; align-items: center; padding: 8px 10px; border-radius: var(--radius-sm); background: linear-gradient(120deg, rgba(242,237,230,.85), rgba(237,232,225,.8)); margin-bottom: 5px; border: 1px solid rgba(36,34,27,.08); transition: .18s; }
.rule-row:hover { border-color: var(--border-green); }
.rule-priority { width: 32px; height: 28px; background: var(--mustard); border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: .8rem; font-weight: 700; color: var(--jet); font-family: var(--font-mono); }
.rule-condition { font-family: var(--font-mono); font-size: .82rem; color: #2A2820; background: rgba(255,255,255,.6); padding: 5px 9px; border-radius: 4px; border: 1px solid rgba(36,34,27,.15); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.rule-condition.default { color: var(--jet); font-weight: 700; background: var(--mustard-dim); border-color: rgba(242,208,78,.4); }

/* ── FLOW DIAGRAM ── */
.flow-diagram { display: flex; align-items: flex-start; gap: 0; padding: 20px 0; overflow: hidden; position: relative; width: 100%; }
.flow-node { display: flex; flex-direction: column; align-items: center; position: relative; flex: 1; min-width: 140px; }
.flow-node.slide-in { animation: flowSlideIn .4s cubic-bezier(.34,1.56,.64,1) both; }
.flow-node.slide-out { animation: flowSlideOut .3s ease-in both; }
@keyframes flowSlideIn { from { opacity: 0; transform: translateX(60px) scale(.92); } to { opacity: 1; transform: translateX(0) scale(1); } }
@keyframes flowSlideOut { from { opacity: 1; transform: translateX(0) scale(1); } to { opacity: 0; transform: translateX(-60px) scale(.92); } }
.flow-connector { display: flex; align-items: center; padding-top: 30px; flex-shrink: 0; flex: 0 0 48px; }
.flow-connector-line { flex: 1; width: 48px; height: 3px; background: var(--bg-4); position: relative; transition: background .3s; }
.flow-connector-line.done { background: var(--mustard); box-shadow: 0 0 5px var(--mustard-glow); }
.flow-connector-line.active { background: var(--blue); }
.flow-connector-arrow { width: 0; height: 0; border-top: 6px solid transparent; border-bottom: 6px solid transparent; border-left: 9px solid var(--bg-3); transition: border-left-color .3s; }
.flow-connector-line.done + .flow-connector-arrow { border-left-color: var(--mustard); }
.flow-connector-line.active + .flow-connector-arrow { border-left-color: var(--blue); }

.flow-step-box { width: 100%; max-width: 180px; background: var(--bg-2); border: 1.5px solid var(--border-0); border-radius: var(--radius-md); padding: 16px 12px; text-align: center; transition: all .25s; cursor: default; position: relative; overflow: hidden; }
.flow-step-box::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: var(--bg-4); transition: background .3s; }
.flow-step-box.pending { border-color: var(--border-0); }
.flow-step-box.current { border-color: var(--blue); background: var(--blue-dim); box-shadow: 0 0 16px rgba(100,181,246,.2); }
.flow-step-box.current::before { background: var(--blue); }
.flow-step-box.done { border-color: var(--border-green); background: var(--green-dim); }
.flow-step-box.done::before { background: var(--green); box-shadow: 0 0 6px var(--green-glow); }
.flow-step-box.failed { border-color: rgba(255,95,95,.4); background: var(--red-dim); }
.flow-step-box.failed::before { background: var(--red); }

.flow-step-icon { display: flex; align-items: center; justify-content: center; margin: 0 auto 8px; }
.flow-step-name { font-size: .85rem; font-weight: 700; color: #24221B; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.flow-step-type { font-size: .72rem; color: #5A5548; font-family: var(--font-mono); font-weight: 600; margin-top: 4px; }
.flow-step-status { margin-top: 10px; }

/* ── SPINNER ── */
@keyframes spin { to { transform: rotate(360deg); } }
.spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--bg-4); border-top-color: var(--blue); border-radius: 50%; animation: spin .8s linear infinite; vertical-align: middle; }

/* ── PROGRESS BAR ── */
.progress-wrap { background: var(--bg-3); border-radius: 20px; height: 5px; overflow: hidden; margin: 12px 0; }
.progress-bar { height: 100%; background: var(--mustard); border-radius: 20px; transition: width .6s ease; box-shadow: 0 0 10px var(--mustard-glow); }

/* ── APPROVAL PANEL ── */
.approval-panel { background: var(--bg-2); border: 1px solid var(--blue-dim); border-radius: var(--radius-md); padding: 14px; margin-top: 12px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.approval-info { flex: 1; font-size: .82rem; color: #24221B; font-weight: 600; }
.approval-sub { font-size: .72rem; color: #5A5548; font-family: var(--font-mono); font-weight: 600; margin-top: 2px; }

/* ── RETRY PANEL ── */
.retry-panel { background: var(--red-dim); border: 1px solid rgba(255,95,95,.25); border-radius: var(--radius-md); padding: 14px 18px; margin-top: 12px; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; animation: flowSlideIn .35s cubic-bezier(.34,1.56,.64,1) both; }
.retry-panel-icon { width: 36px; height: 36px; background: rgba(255,95,95,.12); border: 1px solid rgba(255,95,95,.2); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--red); flex-shrink: 0; }
.retry-panel-info { flex: 1; }
.retry-panel-title { font-size: .84rem; font-weight: 700; color: var(--red); }
.retry-panel-sub { font-size: .72rem; color: var(--text-2); font-family: var(--font-mono); font-weight: 600; margin-top: 2px; }

/* ── LOG ENTRIES ── */
.log-entry { background: linear-gradient(120deg, rgba(245,242,238,.9), rgba(240,235,228,.85)); border: 1px solid rgba(36,34,27,.08); border-radius: var(--radius-md); margin-bottom: 6px; overflow: hidden; transition: border-color .18s; }
.log-entry:hover { border-color: var(--border-1); }
.log-header { padding: 10px 14px; display: flex; align-items: center; gap: 10px; cursor: pointer; transition: .18s; }
.log-header:hover { background: var(--bg-3); }
.log-step-num { width: 22px; height: 22px; border-radius: 4px; background: var(--mustard); color: var(--jet); font-size: .7rem; font-weight: 700; display: flex; align-items: center; justify-content: center; font-family: var(--font-mono); flex-shrink: 0; }
.log-step-title { font-weight: 700; font-size: .86rem; flex: 1; font-family: var(--font-display); color: #24221B; }
.log-body { padding: 0 14px 12px; display: none; }
.log-body.open { display: block; }
.log-json { background: rgba(36,34,27,.06); border: 1px solid rgba(36,34,27,.12); border-radius: var(--radius-sm); padding: 10px; font-family: var(--font-mono); font-size: .72rem; white-space: pre-wrap; color: #3A3830; max-height: 180px; overflow-y: auto; margin-top: 8px; }
.rule-eval-row { display: flex; gap: 8px; align-items: center; font-size: .74rem; padding: 3px 0; font-family: var(--font-mono); }
.rule-eval-cond { color: var(--text-1); flex: 1; }
.next-badge { display: inline-flex; align-items: center; gap: 5px; background: var(--mustard-dim); color: var(--jet); padding: 3px 10px; border-radius: 4px; font-size: .72rem; font-weight: 600; margin-top: 6px; font-family: var(--font-mono); border: 1px solid rgba(242,208,78,.5); }

/* ── SCHEMA ROWS ── */
.schema-field-row { display: grid; grid-template-columns: 1fr 80px 60px auto; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border-0); font-size: .8rem; }

/* ── ALLOWED VALUES ── */
.allowed-vals { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.allowed-tag { background: var(--mustard-dim); color: var(--jet); border: 1px solid rgba(242,208,78,.4); padding: 2px 8px; border-radius: 4px; font-size: .72rem; display: flex; align-items: center; gap: 4px; font-family: var(--font-mono); }
.allowed-tag button { background: none; border: none; cursor: pointer; color: var(--jet); font-size: .85rem; padding: 0; line-height: 1; }

/* ── TOASTS ── */
.toast-container { position: fixed; bottom: 20px; right: 20px; z-index: 9999; display: flex; flex-direction: column; gap: 6px; }
.toast { background: var(--bg-2); border-radius: var(--radius-md); padding: 10px 16px; box-shadow: var(--shadow-lg); font-size: .8rem; display: flex; align-items: center; gap: 10px; border: 1px solid var(--border-1); animation: toastIn .2s ease; max-width: 300px; font-family: var(--font-mono); }
.toast.success { border-left: 3px solid var(--mustard); }
.toast.error { border-left: 3px solid var(--red); }
@keyframes toastIn { from { transform: translateX(40px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

/* ── EMPTY STATES ── */
.empty-state { text-align: center; padding: 40px 24px; color: var(--text-2); }
.empty-state .es-icon { margin: 0 auto 12px; width: 56px; height: 56px; background: var(--bg-2); border-radius: 14px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--border-0); }
.empty-state .title { font-size: .9rem; font-weight: 700; color: #4A4740; margin-bottom: 4px; font-family: var(--font-display); }
.empty-state .sub { font-size: .78rem; color: #7A7568; font-family: var(--font-mono); font-weight: 600; }

/* ── BREADCRUMB ── */
.breadcrumb { display: flex; align-items: center; gap: 6px; font-size: .74rem; color: #6A6558; font-family: var(--font-mono); font-weight: 600; margin-bottom: 4px; }
.breadcrumb span { cursor: pointer; color: var(--green); font-weight: 500; }
.breadcrumb span:hover { text-decoration: underline; }

/* ── MISC ── */
.divider { height: 1px; background: var(--border-0); margin: 12px 0; }
.flex { display: flex; }
.gap-2 { gap: 8px; }
.items-center { align-items: center; }
.justify-between { justify-content: space-between; }
.mb-2 { margin-bottom: 8px; }
.mt-2 { margin-top: 8px; }
.text-muted { color: #6A6558; font-size: .78rem; font-family: var(--font-mono); font-weight: 500; }

code { font-family: var(--font-mono); background: var(--mustard-dim); border: 1px solid rgba(242,208,78,.35); padding: 1px 5px; border-radius: 3px; font-size: .8em; color: var(--jet); }

/* ── ENTER ANIMATIONS ── */

/* ── RICH ANIMATIONS ── */
@keyframes fadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideInLeft { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }
@keyframes slideInRight { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
@keyframes scaleIn { from { opacity: 0; transform: scale(.92); } to { opacity: 1; transform: scale(1); } }
@keyframes floatY { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
@keyframes floatYSlow { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
@keyframes orbitCW { from { transform: rotate(0deg) translateX(28px) rotate(0deg); } to { transform: rotate(360deg) translateX(28px) rotate(-360deg); } }
@keyframes orbitCCW { from { transform: rotate(0deg) translateX(22px) rotate(0deg); } to { transform: rotate(-360deg) translateX(22px) rotate(360deg); } }
@keyframes flowPulse { 0%,100% { stroke-dashoffset: 0; opacity:.8; } 50% { stroke-dashoffset: -20; opacity:1; } }
@keyframes nodePop { 0% { transform: scale(1); } 50% { transform: scale(1.08); } 100% { transform: scale(1); } }
@keyframes dashFlow { from { stroke-dashoffset: 24; } to { stroke-dashoffset: 0; } }
@keyframes glowPulse { 0%,100% { filter: drop-shadow(0 0 4px rgba(242,208,78,.4)); } 50% { filter: drop-shadow(0 0 12px rgba(242,208,78,.8)); } }
@keyframes countUp { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
@keyframes shimmerSlide { 0% { background-position: -400px 0; } 100% { background-position: 400px 0; } }
@keyframes blobMorph {
  0%,100% { border-radius: 60% 40% 30% 70%/60% 30% 70% 40%; }
  25% { border-radius: 30% 60% 70% 40%/50% 60% 30% 60%; }
  50% { border-radius: 50% 60% 30% 70%/30% 60% 70% 40%; }
  75% { border-radius: 70% 30% 50% 50%/30% 50% 70% 60%; }
}
@keyframes dataStream {
  0% { transform: translateY(0); opacity: 1; }
  100% { transform: translateY(-40px); opacity: 0; }
}
@keyframes checkDraw {
  from { stroke-dashoffset: 30; }
  to { stroke-dashoffset: 0; }
}
@keyframes ringExpand {
  0% { transform: scale(0.8); opacity: 0.8; }
  100% { transform: scale(1.6); opacity: 0; }
}

.page.active .card { animation: fadeUp .3s ease both; }
.page.active .card:nth-child(1) { animation-delay: .03s; }
.page.active .card:nth-child(2) { animation-delay: .08s; }
.page.active .card:nth-child(3) { animation-delay: .13s; }
.page.active .stat-card { animation: scaleIn .3s ease both; }
.page.active .stat-card:nth-child(1) { animation-delay: .04s; }
.page.active .stat-card:nth-child(2) { animation-delay: .09s; }
.page.active .stat-card:nth-child(3) { animation-delay: .14s; }
.page.active .stat-card:nth-child(4) { animation-delay: .19s; }
.page.active .hero-banner { animation: fadeUp .35s ease both; animation-delay: .01s; }

/* ── HOVER LIFT for step cards ── */
.step-card { transition: all .22s cubic-bezier(.34,1.56,.64,1); }
.step-card:hover { transform: translateY(-2px) scale(1.01); }

/* ── BUTTON PULSE on primary ── */
.btn-primary { position: relative; overflow: hidden; }
.btn-primary::after { content:''; position:absolute; inset:0; background:rgba(255,255,255,.15); transform:scaleX(0); transform-origin:left; transition:transform .3s ease; border-radius:inherit; }
.btn-primary:hover::after { transform:scaleX(1); }

/* ── NAV ITEM slide indicator ── */
.nav-item { transition: all .2s cubic-bezier(.34,1.3,.64,1); }
.nav-item:hover { transform: translateX(3px); }
.nav-item.active { transform: translateX(0); }

/* ── TABLE ROW hover slide ── */
tbody tr { transition: all .15s ease; }
tbody tr:hover { transform: translateX(2px); }

/* ── ILLUSTRATION CONTAINERS ── */
.illus-wrap { position: relative; display: flex; align-items: center; justify-content: center; }
.illus-float { animation: floatY 3.5s ease-in-out infinite; }
.illus-float-slow { animation: floatYSlow 5s ease-in-out infinite; }
.illus-glow { animation: glowPulse 2.5s ease-in-out infinite; }

/* ── HERO ILLUSTRATION ── */
.hero-illus-wrap {
  position: relative;
  width: 260px; height: 100px;
  flex-shrink: 0;
}
.hero-illus-wrap svg { overflow: visible; }

/* ── PAGE ILLUSTRATIONS ── */
.page-illus {
  display: flex; align-items: center; gap: 20px;
  background: linear-gradient(120deg, rgba(36,34,27,.88) 0%, rgba(45,42,30,.85) 100%);
  border: 1px solid rgba(242,208,78,.2);
  border-radius: var(--radius-lg);
  padding: 20px 24px;
  margin-bottom: 4px;
  overflow: hidden;
  position: relative;
}
.page-illus::before {
  content: '';
  position: absolute; inset: 0;
  background: radial-gradient(ellipse at 80% 50%, rgba(242,208,78,.15) 0%, transparent 60%);
  pointer-events: none;
}
.page-illus-text h3 { font-size: 1.05rem; font-weight: 700; color: var(--mustard); margin-bottom: 4px; font-family: var(--font-display); }
.page-illus-text p { font-size: .76rem; color: rgba(228,223,216,.6); font-family: var(--font-mono); max-width: 320px; line-height: 1.5; }
.page-illus-img { margin-left: auto; flex-shrink: 0; }

/* ── STAT CARD value animation ── */
.stat-value { animation: countUp .4s ease both; animation-delay: .2s; }

/* ── FLOW DIAGRAM animated connectors ── */
.flow-connector-line.done {
  background: var(--mustard);
  position: relative;
  overflow: hidden;
}
.flow-connector-line.done::after {
  content: '';
  position: absolute;
  top: 0; left: -100%;
  width: 60%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,.6), transparent);
  animation: shimmerSlide 1.5s ease-in-out infinite;
}

/* ── RING EXPAND on stat icon ── */
.stat-icon-wrap { position: relative; }
.stat-icon-wrap::after {
  content: '';
  position: absolute; inset: -4px;
  border-radius: 50%;
  border: 1.5px solid rgba(242,208,78,.3);
  animation: ringExpand 2.5s ease-out infinite;
  pointer-events: none;
}


/* ── HERO BANNER ── */
.hero-banner {
  background: linear-gradient(120deg, rgba(36,34,27,.93) 0%, rgba(42,40,30,.9) 55%, rgba(50,46,32,.88) 100%);
  border: 1px solid rgba(242,208,78,.25);
  border-radius: var(--radius-lg);
  padding: 22px 26px;
  display: flex;
  align-items: center;
  gap: 20px;
  overflow: hidden;
  position: relative;
}
.hero-banner::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at 85% 50%, rgba(242,208,78,.2) 0%, transparent 55%), radial-gradient(ellipse at 10% 50%, rgba(242,208,78,.06) 0%, transparent 45%);
  pointer-events: none;
}
.hero-text h2 { font-size: 1.15rem; font-weight: 800; color: var(--mustard); letter-spacing: -0.5px; font-family: var(--font-display); }
.hero-text p { font-size: .78rem; color: rgba(228,223,216,.65); margin-top: 4px; font-family: var(--font-mono); }
.hero-visual { margin-left: auto; flex-shrink: 0; opacity: .7; }

/* ── WORKFLOW TABLE TYPE ICONS ── */
.wf-icon {
  width: 32px; height: 32px;
  background: var(--mustard-dim);
  border: 1px solid rgba(242,208,78,.4);
  border-radius: 8px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--jet); flex-shrink: 0; vertical-align: middle;
  margin-right: 8px;
}

/* ══════════════════════════════════════
   DARK MODE — body.dark
══════════════════════════════════════ */

/* Smooth theme transition — only on key properties, not animations */
body, .sidebar, .main, .topbar, .card, .stat-card, .step-card,
.rule-row, .log-entry, .modal, .hero-banner, .page-illus,
.nav-item, .btn, .form-input, .flow-step-box, tbody tr, thead th,
.badge, .toggle, .wf-icon, .card-title, .breadcrumb {
  transition: background .35s ease, background-color .35s ease,
              border-color .35s ease, color .35s ease, box-shadow .35s ease !important;
}

body.dark {
  /* ── SIDEBAR: Mustard Yellow bg, Black text ── */
  --sidebar-bg: #F2D04E;
  --sidebar-text: #24221B;
  --sidebar-text-muted: rgba(36,34,27,.5);
  --sidebar-border: rgba(36,34,27,.15);
  --sidebar-active-bg: rgba(36,34,27,.12);
  --sidebar-active-text: #24221B;
  --sidebar-hover-bg: rgba(36,34,27,.08);
  --sidebar-section-text: rgba(36,34,27,.45);
  --sidebar-footer-bg: rgba(36,34,27,.08);
  --sidebar-footer-border: rgba(36,34,27,.18);

  /* ── MAIN AREA: Jet Black bg, Mustard + White text ── */
  --bg-0: #1A1810;
  --bg-1: #24221B;
  --bg-2: #2E2C22;
  --bg-3: #38362A;
  --bg-4: #424038;

  --text-0: #FFFFFF;
  --text-1: #F2D04E;
  --text-2: #C8C4B8;
  --text-3: #8A8678;

  --border-0: rgba(228,223,216,.1);
  --border-1: rgba(228,223,216,.18);
  --border-green: rgba(242,208,78,.4);

  /* Outlines use Silver Beige */
  --outline-color: #E4DFD8;
  --card-border: rgba(228,223,216,.15);
}

/* ── SIDEBAR DARK MODE ──
   Background: Silver Beige (#E4DFD8)
   Primary text: Mustard Yellow (#F2D04E)
   Secondary text: Black (#24221B)
── */
body.dark .sidebar {
  background: #E4DFD8 !important;
  border-right: 1px solid rgba(36,34,27,.12) !important;
}
body.dark .sidebar::after {
  background: linear-gradient(180deg, transparent, rgba(242,208,78,.3) 40%, transparent) !important;
}
body.dark .sidebar-logo {
  border-bottom: 1px solid rgba(36,34,27,.1) !important;
}
/* Brand name — deep mustard on beige, highly readable */
body.dark .brand {
  color: #24221B !important;
  font-weight: 800 !important;
}
body.dark .brand span {
  color: #B8900A !important;
}
/* Tagline — dark, clearly readable */
body.dark .tagline {
  color: #7A6A40 !important;
}
/* Section labels — dark brown, clearly readable */
body.dark .nav-section {
  color: #8A7850 !important;
  letter-spacing: 2px;
}
/* Nav items — solid dark jet, max contrast on beige */
body.dark .nav-item {
  color: #2A2418 !important;
  font-weight: 600 !important;
}
body.dark .nav-item:hover {
  color: #24221B !important;
  background: rgba(36,34,27,.1) !important;
  transform: translateX(3px);
}
/* Active nav — deep mustard bg, jet black text */
body.dark .nav-item.active {
  color: #24221B !important;
  border-left-color: #B8900A !important;
  background: rgba(184,144,10,.18) !important;
  font-weight: 800 !important;
}
body.dark .nav-item.active .nav-icon { color: #B8900A !important; }
body.dark .nav-icon { color: #5A4E30 !important; }
body.dark .nav-item:hover .nav-icon { color: #24221B !important; }
body.dark .sidebar-footer {
  border-top: 1px solid rgba(36,34,27,.15) !important;
}
body.dark .db-indicator {
  background: rgba(36,34,27,.08) !important;
  border: 1px solid rgba(36,34,27,.18) !important;
}
body.dark .db-dot {
  background: #B8900A !important;
  box-shadow: 0 0 6px rgba(184,144,10,.6) !important;
}
/* DB label — dark, readable */
body.dark .db-label { color: #5A4E30 !important; font-weight: 600 !important; }
/* DB version — deep mustard */
body.dark .db-version { color: #B8900A !important; font-weight: 700 !important; }

/* ── LOGO HEX DARK MODE ── */
body.dark .logo-hex svg polygon:first-child { stroke: rgba(36,34,27,0.25) !important; }
body.dark .logo-hex svg polygon:last-child { stroke: rgba(184,144,10,0.7) !important; fill: rgba(184,144,10,0.1) !important; }

/* ── TOPBAR DARK MODE ── */
body.dark .topbar {
  background: linear-gradient(90deg, #1A1810 0%, #24221B 60%, #2A2820 100%) !important;
  border-bottom: 1px solid rgba(242,208,78,.2) !important;
}

/* ── MAIN CONTENT DARK MODE ── */
body.dark .main {
  background:
    radial-gradient(ellipse 80% 50% at 90% 0%, rgba(242,208,78,.08) 0%, transparent 60%),
    radial-gradient(ellipse 60% 40% at 0% 100%, rgba(242,208,78,.05) 0%, transparent 55%),
    linear-gradient(160deg, #1A1810 0%, #1E1C14 50%, #24221B 100%) !important;
}

/* ── CARDS DARK MODE ── */
body.dark .card {
  background: rgba(36,34,27,.85) !important;
  border: 1px solid rgba(228,223,216,.12) !important;
  box-shadow: 0 2px 8px rgba(0,0,0,.3) !important;
}
body.dark .card:hover {
  border-color: rgba(242,208,78,.3) !important;
  background: rgba(42,40,30,.9) !important;
}
body.dark .stat-card {
  background: linear-gradient(135deg, rgba(42,40,30,.9) 0%, rgba(36,34,27,.95) 100%) !important;
  border: 1px solid rgba(228,223,216,.12) !important;
}
body.dark .stat-card:hover {
  border-color: rgba(242,208,78,.4) !important;
}

/* ── TABLE DARK MODE ── */
body.dark thead tr { background: #F2D04E !important; }
body.dark thead th {
  background: #F2D04E !important;
  color: #24221B !important;
  border-bottom: 3px solid rgba(36,34,27,.3) !important;
}
body.dark tbody tr {
  background: rgba(36,34,27,.7) !important;
  border-bottom: 1px solid rgba(228,223,216,.08) !important;
}
body.dark tbody tr:nth-child(even) {
  background: rgba(42,40,30,.8) !important;
}
body.dark tbody tr:hover {
  background: rgba(242,208,78,.1) !important;
  box-shadow: inset 3px 0 0 #F2D04E !important;
}
body.dark tbody td {
  color: #FFFFFF !important;
}
body.dark .uuid-cell {
  color: #F2D04E !important;
  background: rgba(242,208,78,.1) !important;
}

/* Dynamic table cell classes — theme-aware */
.wf-name-cell  { color: #1A1812; }
.wf-desc-cell  { color: #7A7568; }
.wf-step-cell  { color: #3A3428; }
.wf-version-cell { color: #5A5548; }
.wf-meta-cell  { color: #5A5548; }

body.dark .wf-name-cell    { color: #F5F2EE !important; }
body.dark .wf-desc-cell    { color: #A8A49A !important; }
body.dark .wf-step-cell    { color: #C8C4B8 !important; }
body.dark .wf-version-cell { color: #C8C4B8 !important; }
body.dark .wf-meta-cell    { color: #A8A49A !important; }

/* ── FORM ELEMENTS DARK MODE ── */
body.dark .form-input {
  background: rgba(228,223,216,.06) !important;
  border: 1px solid rgba(228,223,216,.2) !important;
  color: #FFFFFF !important;
}
body.dark .input-wrap input,
body.dark .input-wrap select {
  background: rgba(228,223,216,.06) !important;
  border: 1px solid rgba(228,223,216,.2) !important;
  color: #FFFFFF !important;
}
body.dark .form-label { color: #C8C4B8 !important; }
body.dark .form-hint { color: #8A8678 !important; }

/* ── STEP CARDS DARK MODE ── */
body.dark .step-card {
  background: linear-gradient(120deg, rgba(42,40,30,.9), rgba(36,34,27,.85)) !important;
  border: 1px solid rgba(228,223,216,.1) !important;
}
body.dark .step-card:hover {
  border-color: rgba(242,208,78,.4) !important;
}
body.dark .step-name { color: #FFFFFF !important; }
body.dark .step-order {
  background: #F2D04E !important;
  border-color: #F2D04E !important;
  color: #24221B !important;
}

/* ── RULE ROWS DARK MODE ── */
body.dark .rule-row {
  background: linear-gradient(120deg, rgba(42,40,30,.9), rgba(36,34,27,.85)) !important;
  border: 1px solid rgba(228,223,216,.1) !important;
}
body.dark .rule-condition {
  background: rgba(228,223,216,.05) !important;
  border: 1px solid rgba(228,223,216,.15) !important;
  color: #F2D04E !important;
}
body.dark .rule-condition.default {
  background: rgba(242,208,78,.1) !important;
  color: #F2D04E !important;
}

/* ── LOG ENTRIES DARK MODE ── */
body.dark .log-entry {
  background: rgba(36,34,27,.8) !important;
  border: 1px solid rgba(228,223,216,.1) !important;
}
body.dark .log-header:hover { background: rgba(42,40,30,.9) !important; }
body.dark .log-json {
  background: rgba(0,0,0,.3) !important;
  border: 1px solid rgba(228,223,216,.1) !important;
  color: #C8C4B8 !important;
}
body.dark .log-step-title { color: #FFFFFF !important; }

/* ── BADGES DARK MODE ── */
body.dark .badge-completed { background: rgba(242,208,78,.15) !important; color: #F2D04E !important; border-color: rgba(242,208,78,.3) !important; }
body.dark .badge-active    { background: rgba(242,208,78,.15) !important; color: #F2D04E !important; border-color: rgba(242,208,78,.3) !important; }
body.dark .badge-pending   { background: rgba(242,208,78,.1)  !important; color: #F2D04E !important; }
body.dark .badge-in_progress { background: rgba(100,181,246,.15) !important; }
body.dark .badge-canceled  { background: rgba(228,223,216,.08) !important; color: #C8C4B8 !important; }

/* ── MODALS DARK MODE ── */
body.dark .modal {
  background: linear-gradient(145deg, rgba(36,34,27,.98) 0%, rgba(30,28,20,.96) 100%) !important;
  border: 1px solid rgba(228,223,216,.18) !important;
}
body.dark .modal-overlay { background: rgba(0,0,0,.75) !important; }
body.dark .modal-close {
  background: rgba(228,223,216,.08) !important;
  border-color: rgba(228,223,216,.15) !important;
  color: #C8C4B8 !important;
}
body.dark .modal-title { color: #FFFFFF !important; }
body.dark .modal-header { border-bottom-color: rgba(228,223,216,.1) !important; }
body.dark .modal-footer { border-top-color: rgba(228,223,216,.1) !important; }
body.dark .divider { background: rgba(228,223,216,.1) !important; }

/* ── SCHEMA ROWS DARK MODE ── */
body.dark .schema-field-row { border-bottom-color: rgba(228,223,216,.1) !important; }

/* ── CARD TITLE DARK ── */
body.dark .card-title { color: #C8C4B8 !important; }
body.dark .card-title-icon { background: rgba(242,208,78,.15) !important; color: #F2D04E !important; }

/* ── STAT LABELS DARK ── */
body.dark .stat-label { color: #C8C4B8 !important; }
body.dark .stat-value { color: #FFFFFF !important; }
body.dark .stat-value.green { color: #F2D04E !important; }
body.dark .stat-value.blue { color: #64b5f6 !important; }
body.dark .stat-trend.neutral { background: rgba(228,223,216,.08) !important; color: #C8C4B8 !important; }
body.dark .stat-trend.up { background: rgba(242,208,78,.15) !important; color: #F2D04E !important; }

/* ── BREADCRUMB DARK ── */
body.dark .breadcrumb { color: #8A8678 !important; }
body.dark .breadcrumb span { color: #F2D04E !important; }

/* ── TEXT-MUTED DARK ── */
body.dark .text-muted { color: #8A8678 !important; }
body.dark code { background: rgba(242,208,78,.12) !important; border-color: rgba(242,208,78,.2) !important; color: #F2D04E !important; }

/* ── FLOW DIAGRAM DARK ── */
body.dark .flow-step-box { background: rgba(36,34,27,.9) !important; border-color: rgba(228,223,216,.12) !important; }
body.dark .flow-step-box.done { background: rgba(242,208,78,.12) !important; border-color: rgba(242,208,78,.45) !important; }
body.dark .flow-step-box.current { background: rgba(100,181,246,.12) !important; border-color: rgba(100,181,246,.45) !important; }
body.dark .flow-step-box.failed { background: rgba(192,57,43,.12) !important; }
body.dark .flow-step-name { color: #FFFFFF !important; font-size: .85rem !important; }
body.dark .flow-step-type { color: #8A8678 !important; font-size: .72rem !important; }
body.dark .flow-connector-line { background: rgba(228,223,216,.15) !important; }
body.dark .flow-connector-arrow { border-left-color: rgba(228,223,216,.15) !important; }

/* ── PAGE ILLUS DARK ── */
body.dark .page-illus { background: linear-gradient(120deg, rgba(36,34,27,.95) 0%, rgba(42,40,30,.9) 100%) !important; border-color: rgba(242,208,78,.2) !important; }

/* ── APPROVAL PANEL DARK ── */
body.dark .approval-panel { background: rgba(36,34,27,.85) !important; border-color: rgba(100,181,246,.2) !important; }
body.dark .approval-info { color: #FFFFFF !important; }
body.dark .approval-sub { color: #8A8678 !important; }
body.dark .retry-panel { background: rgba(255,95,95,.08) !important; border-color: rgba(255,95,95,.2) !important; }
body.dark .retry-panel-title { color: #FF7070 !important; }
body.dark .retry-panel-sub { color: #8A8678 !important; }

/* ── BTN GHOST DARK ── */
body.dark .btn-ghost { color: #C8C4B8 !important; border-color: rgba(228,223,216,.2) !important; }
body.dark .btn-ghost:hover { background: rgba(228,223,216,.08) !important; color: #FFFFFF !important; border-color: rgba(228,223,216,.35) !important; }

/* ── TOGGLES ── */
body.dark .toggle { background: rgba(228,223,216,.12) !important; border-color: rgba(228,223,216,.2) !important; }
body.dark .toggle::after { background: #8A8678 !important; }
body.dark .toggle.on { background: #F2D04E !important; border-color: #F2D04E !important; }
body.dark .toggle.on::after { background: #24221B !important; }

/* ── HERO BANNER DARK ── */
body.dark .hero-banner {
  background: linear-gradient(120deg, rgba(10,9,6,.97) 0%, rgba(30,28,20,.95) 55%, rgba(36,34,27,.92) 100%) !important;
  border-color: rgba(242,208,78,.3) !important;
}

/* ── ALLOWED TAGS DARK ── */
body.dark .allowed-tag { background: rgba(242,208,78,.12) !important; color: #F2D04E !important; border-color: rgba(242,208,78,.3) !important; }
body.dark .allowed-tag button { color: #F2D04E !important; }

/* ── TOASTS DARK ── */
body.dark .toast { background: rgba(36,34,27,.95) !important; border-color: rgba(228,223,216,.15) !important; color: #FFFFFF !important; }

/* ── NEXT BADGE DARK ── */
body.dark .next-badge { background: rgba(242,208,78,.12) !important; color: #F2D04E !important; border-color: rgba(242,208,78,.3) !important; }

/* ── WF ICON DARK ── */
body.dark .wf-icon { background: rgba(242,208,78,.1) !important; border-color: rgba(242,208,78,.25) !important; color: #F2D04E !important; }

/* ══ THEME TOGGLE BUTTON ══ */
.theme-toggle {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0;
  background: rgba(228,223,216,.12);
  border: 1px solid rgba(228,223,216,.2);
  border-radius: 30px;
  padding: 3px;
  cursor: pointer;
  width: 80px;
  height: 32px;
  flex-shrink: 0;
}
.theme-toggle-thumb {
  position: absolute;
  left: 3px;
  top: 3px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #F2D04E;
  box-shadow: 0 2px 6px rgba(242,208,78,.5);
  transition: transform .35s cubic-bezier(.34,1.56,.64,1) !important;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px;
  z-index: 2;
}
body.dark .theme-toggle-thumb {
  transform: translateX(48px) !important;
  background: #24221B;
  box-shadow: 0 2px 6px rgba(0,0,0,.5);
}
.theme-toggle-icons {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 0 7px;
  position: relative;
  z-index: 1;
}
.theme-toggle-sun  { color: #F2D04E; font-size: 14px; transition: opacity .3s !important; }
.theme-toggle-moon { color: rgba(228,223,216,.5); font-size: 12px; transition: opacity .3s !important; }
body.dark .theme-toggle-sun  { color: rgba(242,208,78,.3); }
body.dark .theme-toggle-moon { color: #C8C4B8; }
body.dark .theme-toggle {
  background: rgba(242,208,78,.1);
  border-color: rgba(242,208,78,.25);
}


/* ══ DARK MODE DROPDOWN / SELECT / INPUT FIX ══ */
body.dark select,
body.dark textarea {
  background-color: #2E2C22 !important;
  color: #FFFFFF !important;
  border-color: rgba(228,223,216,.2) !important;
  color-scheme: dark !important;
}
body.dark select option {
  background-color: #2E2C22 !important;
  background: #2E2C22 !important;
  color: #FFFFFF !important;
}
body.dark select option:checked {
  background-color: #3E3C2E !important;
  color: #F2D04E !important;
}
body.dark select:focus,
body.dark textarea:focus {
  border-color: rgba(242,208,78,.5) !important;
  box-shadow: 0 0 0 3px rgba(242,208,78,.1) !important;
  outline: none !important;
}
body.dark input::placeholder,
body.dark textarea::placeholder {
  color: rgba(228,223,216,.3) !important;
}
/* Ensure all selects use dark scheme so OS renders dark dropdown */
body.dark * { color-scheme: dark; }
body.dark .sidebar,
body.dark .sidebar * { color-scheme: light; }


/* ══════════════════════════════════════
   HIGH-CONTRAST TABLE OVERRIDE
══════════════════════════════════════ */
thead tr { background: #2A2820 !important; }
thead th {
  background: #2A2820 !important;
  color: #F2D04E !important;
  font-size: .68rem !important;
  font-weight: 700 !important;
  letter-spacing: 2.5px !important;
  text-transform: uppercase !important;
  padding: 13px 16px !important;
  font-family: var(--font-display) !important;
  border-bottom: 3px solid rgba(242,208,78,.6) !important;
}
thead th:first-child { border-radius: 8px 0 0 0; }
thead th:last-child  { border-radius: 0 8px 0 0; }

tbody tr {
  background: rgba(255,255,255,.65) !important;
  border-bottom: 1px solid rgba(36,34,27,.12) !important;
  transition: all .15s ease !important;
}
tbody tr:nth-child(even) {
  background: rgba(220,213,203,.5) !important;
}
tbody tr:hover {
  background: rgba(242,208,78,.12) !important;
  transform: translateX(3px) !important;
  box-shadow: inset 3px 0 0 #F2D04E !important;
}
tbody td {
  padding: 14px 16px !important;
  font-size: .86rem !important;
  color: #1A1812 !important;
  font-weight: 600 !important;
  vertical-align: middle !important;
  border: none !important;
}
.uuid-cell {
  font-family: var(--font-mono) !important;
  font-size: .74rem !important;
  color: #3A3428 !important;
  font-weight: 700 !important;
  background: rgba(36,34,27,.08) !important;
  padding: 2px 7px !important;
  border-radius: 4px !important;
  display: inline-block !important;
  max-width: 110px !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
}

</style>
</head>
<body>

<!-- ── INLINE SVG ICON DEFS (sprite) ── -->
<svg xmlns="http://www.w3.org/2000/svg" style="display:none">
  <symbol id="ic-dashboard" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="2" width="7" height="7" rx="1.5"/>
    <rect x="11" y="2" width="7" height="7" rx="1.5"/>
    <rect x="2" y="11" width="7" height="7" rx="1.5"/>
    <rect x="11" y="11" width="7" height="7" rx="1.5"/>
  </symbol>
  <symbol id="ic-workflow" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <rect x="1.5" y="7.5" width="5" height="5" rx="1.2"/>
    <rect x="7.5" y="7.5" width="5" height="5" rx="1.2"/>
    <rect x="13.5" y="7.5" width="5" height="5" rx="1.2"/>
    <line x1="6.5" y1="10" x2="7.5" y2="10"/>
    <line x1="12.5" y1="10" x2="13.5" y2="10"/>
    <polyline points="11.5,8.8 12.5,10 11.5,11.2"/>
    <polyline points="5.5,8.8 6.5,10 5.5,11.2"/>
  </symbol>
  <symbol id="ic-run" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="10" cy="10" r="7.5"/>
    <polygon points="8,7 14,10 8,13" fill="currentColor" stroke="none"/>
  </symbol>
  <symbol id="ic-audit" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="2" width="14" height="16" rx="2"/>
    <line x1="7" y1="7" x2="13" y2="7"/>
    <line x1="7" y1="10.5" x2="13" y2="10.5"/>
    <line x1="7" y1="14" x2="10" y2="14"/>
  </symbol>
  <symbol id="ic-search" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
    <circle cx="8.5" cy="8.5" r="5.5"/>
    <line x1="12.5" y1="12.5" x2="17" y2="17"/>
  </symbol>
  <symbol id="ic-plus" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <line x1="10" y1="4" x2="10" y2="16"/>
    <line x1="4" y1="10" x2="16" y2="10"/>
  </symbol>
  <symbol id="ic-task" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 3h12a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1z"/>
    <polyline points="7,10 9,12 13,8"/>
  </symbol>
  <symbol id="ic-approval" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 2l1.5 4.5H16l-3.7 2.7 1.4 4.4L10 11l-3.7 2.6 1.4-4.4L4 6.5h4.5z"/>
  </symbol>
  <symbol id="ic-notification" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 2a5.5 5.5 0 015.5 5.5c0 2.6.8 4.1 1.5 5H3c.7-.9 1.5-2.4 1.5-5A5.5 5.5 0 0110 2z"/>
    <path d="M8 16.5a2 2 0 004 0"/>
  </symbol>
  <symbol id="ic-rule" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 6h14M3 10h9M3 14h5"/>
    <circle cx="16" cy="14" r="2.5"/>
    <line x1="17.8" y1="15.8" x2="19" y2="17"/>
  </symbol>
  <symbol id="ic-delete" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="4,6 6,6 16,6"/>
    <path d="M7 6V4h6v2"/>
    <path d="M8 9v5M12 9v5"/>
    <rect x="5" y="6" width="10" height="11" rx="1.5"/>
  </symbol>
  <symbol id="ic-edit" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14.2 3.8a2 2 0 012.8 2.8l-9 9L4 17l1.4-4L14.2 3.8z"/>
  </symbol>
  <symbol id="ic-stats" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="11" width="4" height="6" rx="1"/>
    <rect x="8" y="7" width="4" height="10" rx="1"/>
    <rect x="13" y="3" width="4" height="14" rx="1"/>
  </symbol>
  <symbol id="ic-check" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="4,10 8,14 16,6"/>
  </symbol>
  <symbol id="ic-close" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <line x1="5" y1="5" x2="15" y2="15"/>
    <line x1="15" y1="5" x2="5" y2="15"/>
  </symbol>
  <symbol id="ic-launch" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 3C10 3 14 3 17 6s3 7 3 7"/>
    <path d="M17 6l-7 7"/>
    <path d="M7 3H3v14h14v-4"/>
    <polyline points="13,3 17,3 17,7"/>
  </symbol>
  <symbol id="ic-db" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <ellipse cx="10" cy="5" rx="7" ry="2.5"/>
    <path d="M3 5v4c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V5"/>
    <path d="M3 9v4c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V9"/>
  </symbol>
  <symbol id="ic-bolt" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="12,2 5,11 10,11 8,18 15,9 10,9"/>
  </symbol>
  <symbol id="ic-schema" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="4" width="6" height="4" rx="1"/>
    <rect x="2" y="12" width="6" height="4" rx="1"/>
    <rect x="12" y="8" width="6" height="4" rx="1"/>
    <line x1="8" y1="6" x2="10" y2="6"/>
    <line x1="10" y1="6" x2="10" y2="14"/>
    <line x1="8" y1="14" x2="10" y2="14"/>
    <line x1="10" y1="10" x2="12" y2="10"/>
  </symbol>
  <symbol id="ic-log" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="2" width="14" height="16" rx="2"/>
    <line x1="7" y1="6" x2="13" y2="6"/>
    <line x1="7" y1="9.5" x2="13" y2="9.5"/>
    <line x1="7" y1="13" x2="10" y2="13"/>
    <circle cx="13.5" cy="13.5" r="3" fill="var(--bg-1)" stroke="currentColor"/>
    <line x1="13.5" y1="12" x2="13.5" y2="14"/>
    <line x1="13.5" y1="15" x2="13.5" y2="15.1" stroke-width="2"/>
  </symbol>
  <symbol id="ic-cancel" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
    <circle cx="10" cy="10" r="7.5"/>
    <line x1="7" y1="7" x2="13" y2="13"/>
    <line x1="13" y1="7" x2="7" y2="13"/>
  </symbol>
  <symbol id="ic-retry" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 10a6 6 0 106-6H7"/>
    <polyline points="4,5 4,10 9,10"/>
  </symbol>
  <symbol id="ic-arrow-right" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <line x1="4" y1="10" x2="16" y2="10"/>
    <polyline points="11,5 16,10 11,15"/>
  </symbol>

  <!-- ── EXTENDED ICON LIBRARY ── -->
  <symbol id="ic-clock" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
    <circle cx="10" cy="10" r="7.5"/>
    <polyline points="10,5.5 10,10 13,12.5"/>
  </symbol>

  <symbol id="ic-calendar" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="4" width="14" height="13" rx="2"/>
    <line x1="3" y1="8" x2="17" y2="8"/>
    <line x1="7" y1="2" x2="7" y2="6"/>
    <line x1="13" y1="2" x2="13" y2="6"/>
    <rect x="6" y="11" width="3" height="3" rx="0.5" fill="currentColor" stroke="none"/>
    <rect x="11" y="11" width="3" height="3" rx="0.5" fill="currentColor" stroke="none"/>
  </symbol>

  <symbol id="ic-user" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="10" cy="7" r="3.5"/>
    <path d="M3 17c0-3.3 3.1-6 7-6s7 2.7 7 6"/>
  </symbol>

  <symbol id="ic-users" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="7.5" cy="7" r="3"/>
    <path d="M1 17c0-2.8 2.9-5 6.5-5"/>
    <circle cx="13" cy="6.5" r="2.5"/>
    <path d="M13 11.5c3.3 0 6 2 6 4.5"/>
  </symbol>

  <symbol id="ic-tag" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 3h6l8 8a2 2 0 010 2.8l-3.2 3.2a2 2 0 01-2.8 0L3 9V3z"/>
    <circle cx="7" cy="7" r="1.2" fill="currentColor" stroke="none"/>
  </symbol>

  <symbol id="ic-filter" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
    <path d="M3 5h14M6 10h8M9 15h2"/>
  </symbol>

  <symbol id="ic-copy" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <rect x="8" y="2" width="10" height="12" rx="2"/>
    <path d="M6 6H4a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-2"/>
  </symbol>

  <symbol id="ic-link" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 12l-1.4 1.4A3 3 0 002.4 9.2L9 2.6a3 3 0 014.2 4.2L12 8"/>
    <path d="M12 8l1.4-1.4A3 3 0 0117.6 10.8L11 17.4a3 3 0 01-4.2-4.2L8 12"/>
    <line x1="8" y1="12" x2="12" y2="8"/>
  </symbol>

  <symbol id="ic-eye" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
    <path d="M1 10s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/>
    <circle cx="10" cy="10" r="2.5"/>
  </symbol>

  <symbol id="ic-download" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 3v10M6 9l4 4 4-4"/>
    <path d="M3 15v1a1 1 0 001 1h12a1 1 0 001-1v-1"/>
  </symbol>

  <symbol id="ic-refresh" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M16.5 9A6.5 6.5 0 104 13.5"/>
    <polyline points="4,9 4,14 9,14"/>
  </symbol>

  <symbol id="ic-settings" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="10" cy="10" r="2.5"/>
    <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4"/>
  </symbol>

  <symbol id="ic-info" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
    <circle cx="10" cy="10" r="7.5"/>
    <line x1="10" y1="9" x2="10" y2="14"/>
    <circle cx="10" cy="6.5" r=".8" fill="currentColor" stroke="none"/>
  </symbol>

  <symbol id="ic-warning" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 3L18 17H2L10 3z"/>
    <line x1="10" y1="9" x2="10" y2="13"/>
    <circle cx="10" cy="15.5" r=".8" fill="currentColor" stroke="none"/>
  </symbol>

  <symbol id="ic-success" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="10" cy="10" r="7.5"/>
    <polyline points="6.5,10 8.5,12.5 13.5,7.5"/>
  </symbol>

  <symbol id="ic-failed" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
    <circle cx="10" cy="10" r="7.5"/>
    <line x1="7" y1="7" x2="13" y2="13"/>
    <line x1="13" y1="7" x2="7" y2="13"/>
  </symbol>

  <symbol id="ic-pending" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
    <circle cx="10" cy="10" r="7.5"/>
    <circle cx="7" cy="10" r="1" fill="currentColor" stroke="none"/>
    <circle cx="10" cy="10" r="1" fill="currentColor" stroke="none"/>
    <circle cx="13" cy="10" r="1" fill="currentColor" stroke="none"/>
  </symbol>

  <symbol id="ic-version" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 4h5l7 7-5 5-7-7V4z"/>
    <circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" stroke="none"/>
    <line x1="12" y1="8" x2="16" y2="4"/>
  </symbol>

  <symbol id="ic-steps" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="13" width="5" height="5" rx="1"/>
    <rect x="7.5" y="8" width="5" height="10" rx="1"/>
    <rect x="13" y="3" width="5" height="15" rx="1"/>
  </symbol>

  <symbol id="ic-active" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
    <circle cx="10" cy="10" r="3" fill="currentColor" stroke="none"/>
    <circle cx="10" cy="10" r="6" opacity=".4"/>
    <circle cx="10" cy="10" r="9" opacity=".15"/>
  </symbol>

  <symbol id="ic-trigger" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 10a7 7 0 1014 0 7 7 0 00-14 0z"/>
    <path d="M10 6v4l3 3" />
    <polyline points="10,3 10,1 12,2 10,1 8,2"/>
  </symbol>

  <symbol id="ic-email" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="5" width="16" height="12" rx="2"/>
    <polyline points="2,5 10,12 18,5"/>
  </symbol>

  <symbol id="ic-id" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="5" width="16" height="12" rx="2"/>
    <circle cx="7.5" cy="10" r="2"/>
    <line x1="11" y1="8.5" x2="16" y2="8.5"/>
    <line x1="11" y1="11.5" x2="14" y2="11.5"/>
  </symbol>

  <symbol id="ic-check-circle" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="10" cy="10" r="7.5"/>
    <polyline points="6.5,10 8.5,12.5 13.5,7.5"/>
  </symbol>

  <symbol id="ic-hash" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
    <line x1="5" y1="7" x2="15" y2="7"/>
    <line x1="5" y1="13" x2="15" y2="13"/>
    <line x1="8" y1="3" x2="6" y2="17"/>
    <line x1="14" y1="3" x2="12" y2="17"/>
  </symbol>

  <symbol id="ic-zap" viewBox="0 0 20 20" fill="currentColor" stroke="none">
    <path d="M11 2L4 11h6l-1 7 7-9h-6l1-7z" opacity=".9"/>
  </symbol>

  <symbol id="ic-layers" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="10,2 18,7 10,12 2,7"/>
    <polyline points="2,12 10,17 18,12"/>
  </symbol>

</svg>

<!-- Helper to render inline SVG icon -->
<script>
function icon(id, size) {
  var s = size || 16;
  return '<svg width="' + s + '" height="' + s + '" style="display:block;"><use href="#' + id + '"/></svg>';
}
</script>

<!-- SIDEBAR -->
<aside class="sidebar">
  <div class="sidebar-logo">
    <div class="logo-mark">
      <div class="logo-hex">
        <!-- Rotating outer hex ring -->
        <svg viewBox="0 0 34 34" fill="none" xmlns="http://www.w3.org/2000/svg">
          <polygon points="17,2 29,9 29,23 17,30 5,23 5,9" stroke="rgba(242,208,78,0.4)" stroke-width="1" fill="none" stroke-dasharray="3 3"/>
          <polygon points="17,5 26,10.5 26,21.5 17,27 8,21.5 8,10.5" stroke="rgba(242,208,78,0.75)" stroke-width="1" fill="rgba(242,208,78,0.1)"/>
        </svg>
        <div class="logo-hex-inner">
          <!-- Static bolt inside -->
          <svg viewBox="0 0 14 14" fill="none">
            <polyline points="8.5,1.5 3.5,8 7,8 5.5,12.5 10.5,6 7,6" stroke="#F2D04E" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="#F2D04E" fill-opacity="0.3"/>
          </svg>
        </div>
      </div>
      <div>
        <div class="brand">Ra<span style="color:var(--mustard)">ze</span></div>
      </div>
    </div>
    <div class="tagline">razors through workflows</div>
  </div>

  <div class="nav-section">Workspace</div>
  <div class="nav-item active" onclick="navigate('dashboard')">
    <span class="nav-icon"><svg width="18" height="18"><use href="#ic-dashboard"/></svg></span>
    Dashboard
  </div>
  <div class="nav-item" onclick="navigate('workflows')">
    <span class="nav-icon"><svg width="18" height="18"><use href="#ic-workflow"/></svg></span>
    Workflows
  </div>

  <div class="nav-section">Execution</div>
  <div class="nav-item" onclick="navigate('executions')">
    <span class="nav-icon"><svg width="18" height="18"><use href="#ic-run"/></svg></span>
    Run Workflow
  </div>
  <div class="nav-item" onclick="navigate('audit')">
    <span class="nav-icon"><svg width="18" height="18"><use href="#ic-audit"/></svg></span>
    Audit Log
  </div>

  <div class="sidebar-footer">
    <div class="raze-widget">
      <div class="raze-particles">
        <div class="raze-p"></div>
        <div class="raze-p"></div>
        <div class="raze-p"></div>
        <div class="raze-p"></div>
        <div class="raze-p"></div>
      </div>
      <div class="raze-bolt-wrap">
        <div class="raze-bolt-ring"></div>
        <div class="raze-bolt-core">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <polyline points="8.5,1.5 3.5,8 7,8 5.5,12.5 10.5,6 7,6" stroke="#F2D04E" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="#F2D04E" fill-opacity="0.3"/>
          </svg>
        </div>
      </div>
      <div class="raze-wordmark">Ra<span>ze</span></div>
      <div class="raze-tagline">razors through workflows</div>
    </div>
  </div>
</aside>

<!-- MAIN -->
<div class="main">
  <div class="topbar">
    <div class="topbar-left">
      <div class="topbar-icon" id="topbar-page-icon">
        <svg width="14" height="14"><use href="#ic-dashboard"/></svg>
      </div>
      <div class="topbar-title" id="page-title">Dashboard</div>
    </div>
    <div class="topbar-right">
      <!-- LIVE indicator -->
      <div style="display:flex;align-items:center;gap:5px;padding:3px 10px;background:rgba(242,208,78,.08);border:1px solid rgba(242,208,78,.15);border-radius:20px;">
        <span style="width:6px;height:6px;border-radius:50%;background:#F2D04E;box-shadow:0 0 5px rgba(242,208,78,.8);animation:pulse-dot 1.8s ease-in-out infinite;display:inline-block;"></span>
        <span style="font-size:.65rem;font-family:var(--font-mono);color:rgba(242,208,78,.7);">LIVE</span>
      </div>
      <!-- THEME TOGGLE -->
      <button class="theme-toggle" id="theme-toggle" onclick="toggleTheme()" title="Toggle dark/light mode" style="border:none;outline:none;">
        <div class="theme-toggle-icons">
          <span class="theme-toggle-sun">☀</span>
          <span class="theme-toggle-moon">☾</span>
        </div>
        <div class="theme-toggle-thumb" id="theme-thumb">
          <span id="theme-thumb-icon" style="line-height:1;">☀</span>
        </div>
      </button>
      <div class="topbar-time" id="topbar-clock"></div>
      <div id="topbar-actions"></div>
    </div>
  </div>

  <!-- ── DASHBOARD ── -->
  <div class="page active" id="page-dashboard">
    <!-- ── ANIMATED HERO BANNER ── -->
    <div class="hero-banner">
      <div class="hero-text" style="flex:1;z-index:1;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <div style="width:28px;height:28px;background:rgba(242,208,78,.15);border:1px solid rgba(242,208,78,.35);border-radius:7px;display:flex;align-items:center;justify-content:center;">
            <svg width="14" height="14" fill="none" stroke="#F2D04E" stroke-width="1.6"><polyline points="8.5,1.5 3.5,8 7,8 5.5,12.5 10.5,6 7,6" stroke-linecap="round" stroke-linejoin="round" fill="#F2D04E" fill-opacity="0.3"/></svg>
          </div>
          <span style="font-size:.65rem;font-family:var(--font-mono);color:rgba(242,208,78,.6);letter-spacing:2px;text-transform:uppercase;">Lightning Fast Execution</span>
        </div>
        <h2 style="font-size:1.6rem;font-weight:700;color:#F2D04E;letter-spacing:-0.5px;line-height:1.2;margin-bottom:6px;font-family:'Domine',serif;">Welcome to <em style="font-style:italic;color:#fff;">Raze</em></h2>
        <p style="font-size:.76rem;color:rgba(228,223,216,.55);font-family:var(--font-mono);line-height:1.6;max-width:340px;">Raze through multi-step workflows with razor-sharp rule routing, instant approvals &amp; real-time execution tracking.</p>
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:5px;background:rgba(242,208,78,.1);border:1px solid rgba(242,208,78,.2);border-radius:5px;padding:4px 10px;">
            <svg width="10" height="10" fill="none" stroke="#F2D04E" stroke-width="2"><polyline points="2,5 4.5,7.5 8,2.5" stroke-linecap="round"/></svg>
            <span style="font-size:.68rem;font-family:var(--font-mono);color:rgba(242,208,78,.8);">Visual Rule Engine</span>
          </div>
          <div style="display:flex;align-items:center;gap:5px;background:rgba(242,208,78,.1);border:1px solid rgba(242,208,78,.2);border-radius:5px;padding:4px 10px;">
            <svg width="10" height="10" fill="none" stroke="#F2D04E" stroke-width="2"><polyline points="2,5 4.5,7.5 8,2.5" stroke-linecap="round"/></svg>
            <span style="font-size:.68rem;font-family:var(--font-mono);color:rgba(242,208,78,.8);">Multi-step Approvals</span>
          </div>
          <div style="display:flex;align-items:center;gap:5px;background:rgba(242,208,78,.1);border:1px solid rgba(242,208,78,.2);border-radius:5px;padding:4px 10px;">
            <svg width="10" height="10" fill="none" stroke="#F2D04E" stroke-width="2"><polyline points="2,5 4.5,7.5 8,2.5" stroke-linecap="round"/></svg>
            <span style="font-size:.68rem;font-family:var(--font-mono);color:rgba(242,208,78,.8);">Audit Logging</span>
          </div>
        </div>
      </div>

      <!-- ── ANIMATED WORKFLOW MACHINE ILLUSTRATION ── -->
      <div style="margin-left:auto;flex-shrink:0;z-index:1;">
        <svg width="300" height="110" viewBox="0 0 300 110" fill="none" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;">
          <defs>
            <filter id="glow-hero">
              <feGaussianBlur stdDeviation="2" result="blur"/>
              <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
            <linearGradient id="connector-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stop-color="#F2D04E" stop-opacity="0.8"/>
              <stop offset="100%" stop-color="#F2D04E" stop-opacity="0.3"/>
            </linearGradient>
          </defs>

          <!-- ── NODE 1: INPUT/TRIGGER ── -->
          <g style="animation:floatY 3.2s ease-in-out infinite;">
            <rect x="2" y="28" width="58" height="54" rx="10" fill="rgba(242,208,78,0.12)" stroke="rgba(242,208,78,0.5)" stroke-width="1.5"/>
            <rect x="2" y="28" width="58" height="14" rx="10" fill="rgba(242,208,78,0.25)"/>
            <rect x="2" y="35" width="58" height="7" fill="rgba(242,208,78,0.25)"/>
            <text x="31" y="40" text-anchor="middle" font-size="7" font-family="Space Mono" fill="rgba(242,208,78,0.9)" font-weight="700">TRIGGER</text>
            <!-- circuit icon -->
            <circle cx="18" cy="57" r="7" fill="rgba(242,208,78,0.15)" stroke="rgba(242,208,78,0.5)" stroke-width="1"/>
            <line x1="18" y1="50" x2="18" y2="54" stroke="#F2D04E" stroke-width="1.5" stroke-linecap="round"/>
            <line x1="18" y1="60" x2="18" y2="64" stroke="#F2D04E" stroke-width="1.5" stroke-linecap="round"/>
            <line x1="11" y1="57" x2="15" y2="57" stroke="#F2D04E" stroke-width="1.5" stroke-linecap="round"/>
            <line x1="21" y1="57" x2="25" y2="57" stroke="#F2D04E" stroke-width="1.5" stroke-linecap="round"/>
            <rect x="30" y="52" width="22" height="3" rx="1.5" fill="rgba(242,208,78,0.5)"/>
            <rect x="30" y="58" width="16" height="3" rx="1.5" fill="rgba(242,208,78,0.3)"/>
            <rect x="30" y="64" width="19" height="3" rx="1.5" fill="rgba(242,208,78,0.25)"/>
            <rect x="8" y="72" width="44" height="6" rx="3" fill="rgba(242,208,78,0.2)"/>
          </g>

          <!-- ── CONNECTOR 1 (animated dashes) ── -->
          <g>
            <line x1="62" y1="55" x2="82" y2="55" stroke="rgba(242,208,78,0.25)" stroke-width="1.5" stroke-dasharray="4 3"/>
            <line x1="62" y1="55" x2="82" y2="55" stroke="rgba(242,208,78,0.7)" stroke-width="1.5" stroke-dasharray="4 3" style="animation:dashFlow 1s linear infinite;"/>
            <polygon points="79,51 84,55 79,59" fill="rgba(242,208,78,0.7)"/>
          </g>

          <!-- ── NODE 2: RULES/DECISION ── -->
          <g style="animation:floatY 3.8s ease-in-out infinite;animation-delay:.6s;">
            <rect x="86" y="20" width="64" height="70" rx="10" fill="rgba(242,208,78,0.18)" stroke="rgba(242,208,78,0.7)" stroke-width="2"/>
            <rect x="86" y="20" width="64" height="16" rx="10" fill="rgba(242,208,78,0.35)"/>
            <rect x="86" y="28" width="64" height="8" fill="rgba(242,208,78,0.35)"/>
            <text x="118" y="32" text-anchor="middle" font-size="7" font-family="Space Mono" fill="rgba(36,34,27,0.9)" font-weight="700">RULE ENGINE</text>
            <!-- decision diamond -->
            <polygon points="118,45 128,55 118,65 108,55" fill="rgba(242,208,78,0.2)" stroke="rgba(242,208,78,0.7)" stroke-width="1.5" style="animation:nodePop 2s ease-in-out infinite;"/>
            <text x="118" y="58" text-anchor="middle" font-size="8" fill="#F2D04E" font-weight="700">?</text>
            <rect x="92" y="72" width="52" height="3" rx="1.5" fill="rgba(242,208,78,0.4)"/>
            <rect x="92" y="78" width="38" height="3" rx="1.5" fill="rgba(242,208,78,0.25)"/>
            <!-- glow ring -->
            <circle cx="118" cy="55" r="18" fill="none" stroke="rgba(242,208,78,0.15)" stroke-width="1" style="animation:ringExpand 2s ease-out infinite;"/>
          </g>

          <!-- ── CONNECTOR 2 ── -->
          <g>
            <line x1="152" y1="55" x2="172" y2="55" stroke="rgba(242,208,78,0.25)" stroke-width="1.5" stroke-dasharray="4 3"/>
            <line x1="152" y1="55" x2="172" y2="55" stroke="rgba(242,208,78,0.7)" stroke-width="1.5" stroke-dasharray="4 3" style="animation:dashFlow 1s linear infinite;animation-delay:.4s;"/>
            <polygon points="169,51 174,55 169,59" fill="rgba(242,208,78,0.7)"/>
          </g>

          <!-- ── NODE 3: APPROVAL ── -->
          <g style="animation:floatY 4s ease-in-out infinite;animation-delay:1.1s;">
            <rect x="176" y="28" width="58" height="54" rx="10" fill="rgba(46,109,164,0.15)" stroke="rgba(100,181,246,0.45)" stroke-width="1.5"/>
            <rect x="176" y="28" width="58" height="14" rx="10" fill="rgba(100,181,246,0.2)"/>
            <rect x="176" y="35" width="58" height="7" fill="rgba(100,181,246,0.2)"/>
            <text x="205" y="40" text-anchor="middle" font-size="7" font-family="Space Mono" fill="rgba(100,181,246,0.9)" font-weight="700">APPROVAL</text>
            <!-- person/approval icon -->
            <circle cx="193" cy="55" r="5" fill="rgba(100,181,246,0.2)" stroke="rgba(100,181,246,0.6)" stroke-width="1.2"/>
            <path d="M185 68 Q185 62 193 62 Q201 62 201 68" fill="rgba(100,181,246,0.15)" stroke="rgba(100,181,246,0.5)" stroke-width="1.2"/>
            <circle cx="213" cy="55" r="7" fill="rgba(100,181,246,0.15)" stroke="rgba(100,181,246,0.45)" stroke-width="1"/>
            <polyline points="210,55 212.5,57.5 216.5,52.5" stroke="rgba(100,181,246,0.9)" stroke-width="1.8" stroke-linecap="round" fill="none" style="stroke-dasharray:12;stroke-dashoffset:12;animation:checkDraw .6s ease forwards;animation-delay:1s;"/>
            <rect x="182" y="72" width="44" height="6" rx="3" fill="rgba(100,181,246,0.2)"/>
          </g>

          <!-- ── CONNECTOR 3 ── -->
          <g>
            <line x1="236" y1="55" x2="256" y2="55" stroke="rgba(242,208,78,0.25)" stroke-width="1.5" stroke-dasharray="4 3"/>
            <line x1="236" y1="55" x2="256" y2="55" stroke="rgba(242,208,78,0.7)" stroke-width="1.5" stroke-dasharray="4 3" style="animation:dashFlow 1s linear infinite;animation-delay:.8s;"/>
            <polygon points="253,51 258,55 253,59" fill="rgba(242,208,78,0.7)"/>
          </g>

          <!-- ── NODE 4: COMPLETE ── -->
          <g style="animation:floatY 3.5s ease-in-out infinite;animation-delay:1.8s;">
            <circle cx="275" cy="55" r="24" fill="rgba(242,208,78,0.12)" stroke="rgba(242,208,78,0.5)" stroke-width="1.5"/>
            <circle cx="275" cy="55" r="18" fill="rgba(242,208,78,0.18)" stroke="rgba(242,208,78,0.6)" stroke-width="1"/>
            <circle cx="275" cy="55" r="24" fill="none" stroke="rgba(242,208,78,0.15)" stroke-width="1" style="animation:ringExpand 2.5s ease-out infinite;animation-delay:.5s;"/>
            <polyline points="267,55 273,61 283,48" stroke="#F2D04E" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none" style="stroke-dasharray:22;animation:checkDraw .7s ease forwards;animation-delay:1.5s;"/>
            <text x="275" y="88" text-anchor="middle" font-size="7" font-family="Space Mono" fill="rgba(242,208,78,0.6)" font-weight="700">DONE</text>
          </g>

          <!-- ── FLOATING DATA PARTICLES ── -->
          <circle cx="73" cy="45" r="2" fill="#F2D04E" opacity="0.6" style="animation:dataStream 1.8s ease-in-out infinite;"/>
          <circle cx="163" cy="48" r="1.5" fill="#F2D04E" opacity="0.5" style="animation:dataStream 1.8s ease-in-out infinite;animation-delay:.6s;"/>
          <circle cx="247" cy="46" r="2" fill="#F2D04E" opacity="0.6" style="animation:dataStream 1.8s ease-in-out infinite;animation-delay:1.2s;"/>
        </svg>
      </div>
    </div>

    <div class="stats-row" id="stats-row">
      <div class="skeleton skel-stat"></div>
      <div class="skeleton skel-stat"></div>
      <div class="skeleton skel-stat"></div>
      <div class="skeleton skel-stat"></div>
    </div>
    <div class="card">
      <div class="card-title">
        <span class="card-title-icon"><svg width="12" height="12"><use href="#ic-run"/></svg></span>
        Recent Executions
      </div>
      <div id="dashboard-recent">
        <div class="skeleton skel-row"></div>
        <div class="skeleton skel-row"></div>
        <div class="skeleton skel-row" style="opacity:.5"></div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">
        <span class="card-title-icon"><svg width="12" height="12"><use href="#ic-bolt"/></svg></span>
        Quick Launch
      </div>
      <div id="quick-workflows" style="display:flex;gap:8px;flex-wrap:wrap;">
        <div class="skeleton" style="width:140px;height:32px;border-radius:6px;"></div>
        <div class="skeleton" style="width:160px;height:32px;border-radius:6px;"></div>
      </div>
    </div>
  </div>

  <!-- ── WORKFLOWS ── -->
  <div class="page" id="page-workflows">
    <div class="page-illus">
      <div class="page-illus-text">
        <h3>Workflow Designer</h3>
        <p>Build automated pipelines with steps, rules and conditional routing. Each workflow is a reusable process blueprint.</p>
      </div>
      <div class="page-illus-img">
        <!-- Workflow blueprint illustration -->
        <svg width="200" height="80" viewBox="0 0 200 80" fill="none" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;">
          <!-- blueprint grid -->
          <defs><pattern id="grid-wf" width="12" height="12" patternUnits="userSpaceOnUse"><path d="M 12 0 L 0 0 0 12" fill="none" stroke="rgba(242,208,78,0.08)" stroke-width=".5"/></pattern></defs>
          <rect width="200" height="80" fill="url(#grid-wf)" rx="6"/>
          <!-- step boxes -->
          <rect x="8" y="28" width="40" height="26" rx="5" fill="rgba(242,208,78,0.18)" stroke="rgba(242,208,78,0.5)" stroke-width="1.2" style="animation:floatY 3s ease-in-out infinite;"/>
          <text x="28" y="44" text-anchor="middle" font-size="7.5" font-family="Space Mono" fill="#F2D04E" font-weight="700">START</text>
          <!-- arrow -->
          <line x1="50" y1="41" x2="64" y2="41" stroke="rgba(242,208,78,0.6)" stroke-width="1.5" stroke-dasharray="3 2" style="animation:dashFlow .8s linear infinite;"/>
          <polygon points="62,38 67,41 62,44" fill="rgba(242,208,78,0.6)"/>
          <!-- decision -->
          <polygon points="82,29 98,41 82,53 66,41" fill="rgba(242,208,78,0.15)" stroke="rgba(242,208,78,0.6)" stroke-width="1.2" style="animation:nodePop 2.5s ease-in-out infinite;animation-delay:.4s;"/>
          <text x="82" y="44" text-anchor="middle" font-size="9" fill="#F2D04E" font-weight="700">?</text>
          <!-- branch yes -->
          <line x1="98" y1="35" x2="116" y2="29" stroke="rgba(242,208,78,0.45)" stroke-width="1" stroke-dasharray="3 2"/>
          <rect x="116" y="20" width="36" height="18" rx="4" fill="rgba(100,181,246,0.15)" stroke="rgba(100,181,246,0.45)" stroke-width="1"/>
          <text x="134" y="32" text-anchor="middle" font-size="6.5" font-family="Space Mono" fill="rgba(100,181,246,.8)">APPROVE</text>
          <!-- branch no -->
          <line x1="98" y1="47" x2="116" y2="54" stroke="rgba(255,95,95,0.35)" stroke-width="1" stroke-dasharray="3 2"/>
          <rect x="116" y="46" width="36" height="18" rx="4" fill="rgba(255,95,95,0.12)" stroke="rgba(255,95,95,0.35)" stroke-width="1"/>
          <text x="134" y="58" text-anchor="middle" font-size="6.5" font-family="Space Mono" fill="rgba(255,95,95,.7)">REJECT</text>
          <!-- end -->
          <line x1="154" y1="29" x2="166" y2="38" stroke="rgba(242,208,78,0.35)" stroke-width="1" stroke-dasharray="2 2"/>
          <line x1="154" y1="55" x2="166" y2="44" stroke="rgba(242,208,78,0.35)" stroke-width="1" stroke-dasharray="2 2"/>
          <circle cx="172" cy="41" r="8" fill="rgba(242,208,78,0.2)" stroke="rgba(242,208,78,0.5)" stroke-width="1.2" style="animation:glowPulse 2s ease-in-out infinite;"/>
          <text x="172" y="44" text-anchor="middle" font-size="7" fill="#F2D04E" font-weight="700">✓</text>
          <!-- labels -->
          <text x="101" y="33" font-size="5.5" font-family="Space Mono" fill="rgba(242,208,78,.5)">YES</text>
          <text x="101" y="53" font-size="5.5" font-family="Space Mono" fill="rgba(255,95,95,.5)">NO</text>
        </svg>
      </div>
    </div>
    <div class="card">
      <div class="flex items-center justify-between mb-2">
        <div style="display:flex;gap:8px;flex:1;margin-right:12px;">
          <div class="input-wrap" style="max-width:280px;">
            <span class="icon"><svg width="14" height="14"><use href="#ic-search"/></svg></span>
            <input type="text" placeholder="Search workflows..." id="workflow-search" oninput="renderWorkflowList()">
          </div>
          <select class="form-input" style="width:130px;padding-left:10px;" id="workflow-filter" onchange="renderWorkflowList()">
            <option value="">All Status</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>
        </div>
        <button class="btn btn-primary" onclick="openWorkflowModal()">
          <svg width="14" height="14"><use href="#ic-plus"/></svg>
          New Workflow
        </button>
      </div>
      <div style="overflow-x:auto;">
        <table>
          <thead><tr>
        <th><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;opacity:.8"><use href="#ic-hash"/></svg>ID</th>
        <th><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;opacity:.8"><use href="#ic-workflow"/></svg>Name</th>
        <th><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;opacity:.8"><use href="#ic-steps"/></svg>Steps</th>
        <th><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;opacity:.8"><use href="#ic-version"/></svg>Version</th>
        <th><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;opacity:.8"><use href="#ic-active"/></svg>Status</th>
        <th><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;opacity:.8"><use href="#ic-settings"/></svg>Actions</th>
      </tr></thead>
          <tbody id="workflow-table-body">
            <tr><td colspan="6"><div class="skeleton skel-row" style="margin:4px 0;"></div></td></tr>
            <tr><td colspan="6"><div class="skeleton skel-row" style="margin:4px 0;"></div></td></tr>
          </tbody>
        </table>
      </div>
      <div id="workflow-empty" class="empty-state" style="display:none;">
        <div style="margin:0 auto 16px;width:120px;height:80px;opacity:.7;">
          <svg viewBox="0 0 120 80" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="60" cy="38" r="28" fill="rgba(242,208,78,0.08)" stroke="rgba(242,208,78,0.2)" stroke-width="1.5" stroke-dasharray="6 4"/>
            <rect x="44" y="28" width="32" height="22" rx="5" fill="rgba(242,208,78,0.12)" stroke="rgba(242,208,78,0.35)" stroke-width="1.5" style="animation:floatY 3s ease-in-out infinite;"/>
            <line x1="54" y1="34" x2="66" y2="34" stroke="rgba(242,208,78,0.5)" stroke-width="1.5" stroke-linecap="round"/>
            <line x1="54" y1="39" x2="62" y2="39" stroke="rgba(242,208,78,0.3)" stroke-width="1.2" stroke-linecap="round"/>
            <circle cx="60" cy="38" r="5" fill="rgba(242,208,78,0.15)" stroke="rgba(242,208,78,0.4)" stroke-width="1.2"/>
            <line x1="60" y1="35" x2="60" y2="41" stroke="#F2D04E" stroke-width="1.5" stroke-linecap="round"/>
            <line x1="57" y1="38" x2="63" y2="38" stroke="#F2D04E" stroke-width="1.5" stroke-linecap="round"/>
            <text x="60" y="75" text-anchor="middle" font-size="8" font-family="Space Mono" fill="rgba(242,208,78,0.4)">no workflows</text>
          </svg>
        </div>
        <div class="title">No workflows yet</div>
        <div class="sub">Create your first workflow to get started</div>
      </div>
    </div>
  </div>

  <!-- ── EDITOR ── -->
  <div class="page" id="page-editor">
    <div class="page-illus" style="padding:14px 20px;">
      <div class="page-illus-text">
        <h3 id="editor-illus-name" style="margin:0;">Workflow Editor</h3>
        <p style="margin-top:3px;">Configure steps, define input schema, and wire up transition rules for each step in your workflow.</p>
      </div>
      <div class="page-illus-img">
        <svg width="140" height="60" viewBox="0 0 140 60" fill="none">
          <!-- gear + pencil icon illustration -->
          <circle cx="35" cy="30" r="18" fill="rgba(242,208,78,0.1)" stroke="rgba(242,208,78,0.3)" stroke-width="1.2" stroke-dasharray="5 3" style="animation:hex-spin 12s linear infinite;"/>
          <circle cx="35" cy="30" r="10" fill="rgba(242,208,78,0.15)" stroke="rgba(242,208,78,0.45)" stroke-width="1.5" style="animation:floatY 3s ease-in-out infinite;"/>
          <!-- gear teeth -->
          <rect x="33" y="14" width="4" height="6" rx="2" fill="rgba(242,208,78,0.4)"/>
          <rect x="33" y="40" width="4" height="6" rx="2" fill="rgba(242,208,78,0.4)"/>
          <rect x="14" y="28" width="6" height="4" rx="2" fill="rgba(242,208,78,0.4)"/>
          <rect x="50" y="28" width="6" height="4" rx="2" fill="rgba(242,208,78,0.4)"/>
          <circle cx="35" cy="30" r="4" fill="rgba(242,208,78,0.5)"/>
          <!-- connector -->
          <line x1="55" y1="30" x2="70" y2="30" stroke="rgba(242,208,78,0.4)" stroke-width="1.2" stroke-dasharray="3 2" style="animation:dashFlow .8s linear infinite;"/>
          <!-- pencil/edit block -->
          <rect x="72" y="18" width="56" height="26" rx="6" fill="rgba(36,34,27,0.3)" stroke="rgba(242,208,78,0.3)" stroke-width="1.2" style="animation:floatY 3.5s ease-in-out infinite;animation-delay:.5s;"/>
          <line x1="80" y1="26" x2="118" y2="26" stroke="rgba(242,208,78,0.4)" stroke-width="1.2" stroke-linecap="round"/>
          <line x1="80" y1="31" x2="108" y2="31" stroke="rgba(242,208,78,0.25)" stroke-width="1" stroke-linecap="round"/>
          <line x1="80" y1="36" x2="114" y2="36" stroke="rgba(242,208,78,0.2)" stroke-width="1" stroke-linecap="round"/>
          <!-- cursor blink -->
          <rect x="109" y="29" width="2" height="8" rx="1" fill="#F2D04E" opacity=".8" style="animation:pulse-dot 1s ease-in-out infinite;"/>
        </svg>
      </div>
    </div>
    <div class="breadcrumb">
      <span onclick="navigate('workflows')">workflows</span>
      &rsaquo;
      <span id="editor-breadcrumb-name" style="color:var(--text-0);cursor:default;font-weight:600;"></span>
    </div>
    <div style="display:grid;grid-template-columns:1fr 320px;gap:16px;">
      <div style="display:flex;flex-direction:column;gap:14px;">
        <div class="card">
          <div class="card-title">
            <span class="card-title-icon"><svg width="12" height="12"><use href="#ic-edit"/></svg></span>
            Workflow Details
          </div>
          <div class="form-grid-2">
            <div class="form-row"><label class="form-label">Name</label><input type="text" class="form-input" id="wf-name"></div>
            <div class="form-row"><label class="form-label">Description</label><input type="text" class="form-input" id="wf-desc"></div>
          </div>
          <div class="form-row">
            <label class="form-label" style="display:flex;align-items:center;gap:8px;">
              Active <div class="toggle on" id="wf-active-toggle" onclick="this.classList.toggle('on')"></div>
            </label>
          </div>
          <div style="display:flex;justify-content:flex-end;">
            <button class="btn btn-ghost btn-sm" onclick="saveWorkflow()">
              <svg width="13" height="13"><use href="#ic-check"/></svg>
              Save Changes
            </button>
          </div>
        </div>
        <div class="card">
          <div class="flex items-center justify-between mb-2">
            <div class="card-title" style="margin-bottom:0;">
              <span class="card-title-icon"><svg width="12" height="12"><use href="#ic-workflow"/></svg></span>
              Steps
            </div>
            <button class="btn btn-primary btn-sm" onclick="openStepModal()">
              <svg width="13" height="13"><use href="#ic-plus"/></svg>
              Add Step
            </button>
          </div>
          <div id="steps-list"></div>
          <div id="steps-empty" class="empty-state" style="display:none;padding:28px;">
            <div style="margin:0 auto 12px;width:100px;height:60px;opacity:.65;">
              <svg viewBox="0 0 100 60" fill="none">
                <rect x="5" y="18" width="26" height="26" rx="5" fill="rgba(242,208,78,0.1)" stroke="rgba(242,208,78,0.3)" stroke-width="1.2" stroke-dasharray="4 3" style="animation:floatY 3s ease-in-out infinite;"/>
                <line x1="33" y1="31" x2="43" y2="31" stroke="rgba(242,208,78,0.25)" stroke-width="1.2" stroke-dasharray="3 2"/>
                <rect x="45" y="18" width="26" height="26" rx="5" fill="rgba(242,208,78,0.06)" stroke="rgba(242,208,78,0.2)" stroke-width="1.2" stroke-dasharray="4 3"/>
                <line x1="73" y1="31" x2="83" y2="31" stroke="rgba(242,208,78,0.25)" stroke-width="1.2" stroke-dasharray="3 2"/>
                <rect x="85" y="18" width="10" height="26" rx="4" fill="rgba(242,208,78,0.06)" stroke="rgba(242,208,78,0.15)" stroke-width="1" stroke-dasharray="3 3"/>
                <line x1="50" y1="28" x2="64" y2="28" stroke="rgba(242,208,78,0.2)" stroke-width="1" stroke-linecap="round"/>
                <line x1="50" y1="33" x2="60" y2="33" stroke="rgba(242,208,78,0.15)" stroke-width="1" stroke-linecap="round"/>
              </svg>
            </div>
            <div class="title">No steps yet</div>
            <div class="sub">Add the first step to build your workflow</div>
          </div>
        </div>
      </div>
      <div class="card" style="height:fit-content;">
        <div class="flex items-center justify-between mb-2">
          <div class="card-title" style="margin-bottom:0;">
            <span class="card-title-icon"><svg width="12" height="12"><use href="#ic-schema"/></svg></span>
            Input Schema
          </div>
          <button class="btn btn-ghost btn-sm" onclick="openSchemaModal()">
            <svg width="13" height="13"><use href="#ic-plus"/></svg>
            Field
          </button>
        </div>
        <div id="schema-list"></div>
        <div id="schema-empty" class="empty-state" style="display:none;padding:20px;">
          <div class="es-icon"><svg width="22" height="22" style="color:var(--text-3)"><use href="#ic-schema"/></svg></div>
          <div class="title">No fields</div>
        </div>
        <div class="divider"></div>
        <div class="text-muted">Types: <code>number</code> <code>string</code> <code>boolean</code></div>
      </div>
    </div>
  </div>

  <!-- ── RULES ── -->
  <div class="page" id="page-rules">
    <div class="page-illus" style="padding:14px 20px;">
      <div class="page-illus-text">
        <h3>Rule Engine</h3>
        <p>Conditions are evaluated in priority order. The first matching rule routes execution to the next step.</p>
      </div>
      <div class="page-illus-img">
        <svg width="160" height="60" viewBox="0 0 160 60" fill="none">
          <!-- input -->
          <rect x="4" y="22" width="30" height="18" rx="4" fill="rgba(242,208,78,0.15)" stroke="rgba(242,208,78,0.4)" stroke-width="1.2" style="animation:floatY 3s ease-in-out infinite;"/>
          <text x="19" y="34" text-anchor="middle" font-size="7" font-family="Space Mono" fill="rgba(242,208,78,.8)" font-weight="700">IF</text>
          <line x1="36" y1="31" x2="50" y2="31" stroke="rgba(242,208,78,0.5)" stroke-width="1.2" stroke-dasharray="3 2" style="animation:dashFlow .8s linear infinite;"/>
          <!-- decision -->
          <polygon points="65,16 82,31 65,46 48,31" fill="rgba(242,208,78,0.15)" stroke="rgba(242,208,78,0.55)" stroke-width="1.5" style="animation:nodePop 2.5s ease-in-out infinite;"/>
          <text x="65" y="35" text-anchor="middle" font-size="9" fill="#F2D04E" font-weight="700">?</text>
          <!-- YES branch -->
          <line x1="83" y1="24" x2="100" y2="14" stroke="rgba(100,181,246,.5)" stroke-width="1.2" stroke-dasharray="3 2"/>
          <rect x="102" y="6" width="34" height="16" rx="4" fill="rgba(100,181,246,0.12)" stroke="rgba(100,181,246,0.35)" stroke-width="1" style="animation:floatY 3.2s ease-in-out infinite;animation-delay:.3s;"/>
          <text x="119" y="17" text-anchor="middle" font-size="6.5" font-family="Space Mono" fill="rgba(100,181,246,.8)">NEXT STEP</text>
          <text x="90" y="20" font-size="6" font-family="Space Mono" fill="rgba(100,181,246,.5)">YES</text>
          <!-- NO branch -->
          <line x1="83" y1="38" x2="100" y2="48" stroke="rgba(242,208,78,.4)" stroke-width="1.2" stroke-dasharray="3 2"/>
          <rect x="102" y="40" width="34" height="16" rx="4" fill="rgba(242,208,78,0.1)" stroke="rgba(242,208,78,0.3)" stroke-width="1" style="animation:floatY 3.6s ease-in-out infinite;animation-delay:.6s;"/>
          <text x="119" y="51" text-anchor="middle" font-size="6.5" font-family="Space Mono" fill="rgba(242,208,78,.7)">DEFAULT</text>
          <text x="90" y="48" font-size="6" font-family="Space Mono" fill="rgba(242,208,78,.4)">ELSE</text>
          <!-- priority markers -->
          <rect x="138" y="10" width="16" height="8" rx="3" fill="rgba(100,181,246,0.15)" stroke="rgba(100,181,246,0.3)" stroke-width=".8"/>
          <text x="146" y="17" text-anchor="middle" font-size="5.5" font-family="Space Mono" fill="rgba(100,181,246,.7)">P:1</text>
          <rect x="138" y="44" width="16" height="8" rx="3" fill="rgba(242,208,78,0.1)" stroke="rgba(242,208,78,0.25)" stroke-width=".8"/>
          <text x="146" y="51" text-anchor="middle" font-size="5.5" font-family="Space Mono" fill="rgba(242,208,78,.6)">P:2</text>
        </svg>
      </div>
    </div>
    <div class="breadcrumb">
      <span onclick="navigate('workflows')">workflows</span> &rsaquo;
      <span id="rule-wf-name" onclick="goBackToEditor()"></span> &rsaquo;
      <span style="color:var(--text-0);cursor:default;font-weight:600;" id="rule-step-name"></span>
    </div>
    <div class="card">
      <div class="flex items-center justify-between mb-2">
        <div>
          <div class="card-title" style="margin-bottom:4px;">
            <span class="card-title-icon"><svg width="12" height="12"><use href="#ic-rule"/></svg></span>
            Rule Editor
          </div>
          <p class="text-muted">Priority ordered. First match wins. DEFAULT catches unmatched cases.</p>
        </div>
        <button class="btn btn-primary btn-sm" onclick="openRuleModal()">
          <svg width="13" height="13"><use href="#ic-plus"/></svg>
          Add Rule
        </button>
      </div>
      <div id="rules-list"></div>
      <div id="rules-empty" class="empty-state" style="display:none;padding:28px;">
        <div style="margin:0 auto 12px;width:110px;height:64px;opacity:.65;">
          <svg viewBox="0 0 110 64" fill="none">
            <polygon points="55,10 75,32 55,54 35,32" fill="rgba(242,208,78,0.1)" stroke="rgba(242,208,78,0.4)" stroke-width="1.5" stroke-dasharray="5 3" style="animation:nodePop 3s ease-in-out infinite;"/>
            <text x="55" y="36" text-anchor="middle" font-size="12" fill="rgba(242,208,78,0.5)" font-weight="700">?</text>
            <line x1="10" y1="32" x2="33" y2="32" stroke="rgba(242,208,78,0.25)" stroke-width="1.2" stroke-dasharray="4 3"/>
            <line x1="77" y1="20" x2="95" y2="12" stroke="rgba(242,208,78,0.2)" stroke-width="1.2" stroke-dasharray="3 3"/>
            <line x1="77" y1="44" x2="95" y2="52" stroke="rgba(255,95,95,0.2)" stroke-width="1.2" stroke-dasharray="3 3"/>
            <text x="100" y="15" font-size="7" font-family="Space Mono" fill="rgba(242,208,78,.3)">YES</text>
            <text x="100" y="55" font-size="7" font-family="Space Mono" fill="rgba(255,95,95,.3)">NO</text>
          </svg>
        </div>
        <div class="title">No rules defined</div>
        <div class="sub">Rules determine what happens after each step</div>
      </div>
      <div class="divider"></div>
      <div class="text-muted">
        Operators: <code>==</code> <code>!=</code> <code>&lt;</code> <code>&gt;</code>
        <code>&amp;&amp;</code> <code>||</code> <code>contains()</code> <code>startsWith()</code>
      </div>
    </div>
  </div>

  <!-- ── EXECUTIONS ── -->
  <div class="page" id="page-executions">
    <div class="page-illus">
      <div class="page-illus-text">
        <h3>Execute &amp; Monitor</h3>
        <p>Trigger workflows with dynamic input data. Watch each step execute in real-time with visual progress tracking.</p>
      </div>
      <div class="page-illus-img">
        <!-- Execution engine illustration -->
        <svg width="180" height="80" viewBox="0 0 180 80" fill="none" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;">
          <!-- server/engine block -->
          <rect x="60" y="10" width="60" height="60" rx="8" fill="rgba(36,34,27,.4)" stroke="rgba(242,208,78,0.35)" stroke-width="1.5" style="animation:floatYSlow 4s ease-in-out infinite;"/>
          <!-- server lines -->
          <rect x="68" y="18" width="44" height="8" rx="3" fill="rgba(242,208,78,0.15)" stroke="rgba(242,208,78,0.3)" stroke-width="1"/>
          <circle cx="71" cy="22" r="2" fill="#F2D04E" opacity=".7" style="animation:pulse-dot 1.5s ease-in-out infinite;"/>
          <rect x="76" y="20" width="30" height="4" rx="2" fill="rgba(242,208,78,0.25)"/>
          <rect x="68" y="30" width="44" height="8" rx="3" fill="rgba(242,208,78,0.1)" stroke="rgba(242,208,78,0.2)" stroke-width="1"/>
          <circle cx="71" cy="34" r="2" fill="rgba(100,181,246,.8)" style="animation:pulse-dot 1.8s ease-in-out infinite;animation-delay:.5s;"/>
          <rect x="76" y="32" width="24" height="4" rx="2" fill="rgba(100,181,246,0.2)"/>
          <rect x="68" y="42" width="44" height="8" rx="3" fill="rgba(242,208,78,0.1)" stroke="rgba(242,208,78,0.2)" stroke-width="1"/>
          <circle cx="71" cy="46" r="2" fill="rgba(255,95,95,.6)"/>
          <rect x="76" y="44" width="18" height="4" rx="2" fill="rgba(255,95,95,0.2)"/>
          <!-- progress bar -->
          <rect x="68" y="54" width="44" height="5" rx="2.5" fill="rgba(242,208,78,0.1)" stroke="rgba(242,208,78,0.2)" stroke-width="1"/>
          <rect x="68" y="54" width="28" height="5" rx="2.5" fill="rgba(242,208,78,0.5)" style="animation:shimmerSlide 2s ease-in-out infinite;"/>
          <!-- orbit dots -->
          <g style="transform-origin:90px 40px;animation:orbitCW 4s linear infinite;">
            <circle cx="118" cy="40" r="3" fill="#F2D04E" opacity=".5"/>
          </g>
          <g style="transform-origin:90px 40px;animation:orbitCCW 6s linear infinite;">
            <circle cx="62" cy="40" r="2.5" fill="rgba(100,181,246,.5)"/>
          </g>
          <!-- input arrow -->
          <line x1="10" y1="40" x2="56" y2="40" stroke="rgba(242,208,78,0.5)" stroke-width="1.5" stroke-dasharray="4 3" style="animation:dashFlow .9s linear infinite;"/>
          <polygon points="53,36.5 59,40 53,43.5" fill="rgba(242,208,78,0.6)"/>
          <text x="30" y="35" text-anchor="middle" font-size="6.5" font-family="Space Mono" fill="rgba(242,208,78,.5)">INPUT</text>
          <!-- output arrow -->
          <line x1="124" y1="40" x2="168" y2="40" stroke="rgba(242,208,78,0.5)" stroke-width="1.5" stroke-dasharray="4 3" style="animation:dashFlow .9s linear infinite;animation-delay:.5s;"/>
          <polygon points="165,36.5 171,40 165,43.5" fill="rgba(242,208,78,0.6)"/>
          <circle cx="174" cy="40" r="5" fill="rgba(242,208,78,0.25)" stroke="rgba(242,208,78,0.6)" stroke-width="1.2" style="animation:glowPulse 2s ease-in-out infinite;"/>
          <text x="145" y="35" text-anchor="middle" font-size="6.5" font-family="Space Mono" fill="rgba(242,208,78,.5)">RESULT</text>
        </svg>
      </div>
    </div>
    <div class="card">
      <div class="card-title">
        <span class="card-title-icon"><svg width="12" height="12"><use href="#ic-run"/></svg></span>
        Run Workflow
      </div>
      <div class="form-row">
        <label class="form-label"><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;"><use href="#ic-layers"/></svg>Select Workflow</label>
        <select class="form-input" id="exec-workflow-select" onchange="onExecWorkflowChange()">
          <option value="">Choose a workflow...</option>
        </select>
      </div>
      <div id="exec-input-fields"></div>
      <button class="btn btn-primary" id="exec-start-btn" onclick="startExecution()" style="display:none;margin-top:8px;">
        <svg width="14" height="14"><use href="#ic-run"/></svg>
        Run Execution
      </button>
    </div>
    <div id="exec-progress-card" style="display:none;">
      <div class="card">
        <div class="flex items-center justify-between mb-2">
          <div class="card-title" style="margin-bottom:0;">
            <span class="card-title-icon"><svg width="12" height="12"><use href="#ic-stats"/></svg></span>
            Execution Progress
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <span class="badge" id="exec-status-badge"></span>
            <button class="btn btn-ghost" id="exec-cancel-btn" onclick="cancelExecution()">
              <svg width="15" height="15"><use href="#ic-cancel"/></svg>
              Cancel
            </button>
            <button class="btn btn-ghost" id="exec-retry-btn" onclick="retryExecution()" style="display:none;">
              <svg width="15" height="15"><use href="#ic-retry"/></svg>
              Retry
            </button>
          </div>
        </div>
        <div class="text-muted mb-2" id="exec-meta" style="font-family:var(--font-mono);font-size:.72rem;color:#5A5548;font-weight:600;"></div>
        <div class="progress-wrap"><div class="progress-bar" id="exec-progress-bar" style="width:0%"></div></div>
        <div style="margin-top:16px;display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
          <div id="exec-step-counter" style="font-size:.7rem;font-family:var(--font-mono);color:var(--text-2);font-weight:600;opacity:.7;letter-spacing:.5px;"></div>
        </div>
        <div id="exec-steps-view"></div>
      </div>
      <div class="card" style="margin-top:14px;">
        <div class="card-title">
          <span class="card-title-icon"><svg width="12" height="12"><use href="#ic-log"/></svg></span>
          Execution Logs
        </div>
        <div id="exec-logs-view"></div>
      </div>
    </div>
  </div>

  <!-- ── AUDIT ── -->
  <div class="page" id="page-audit">
    <div class="page-illus">
      <div class="page-illus-text">
        <h3>Audit &amp; History</h3>
        <p>Full execution history with step-level logs, rule evaluations, and performance metrics for every workflow run.</p>
      </div>
      <div class="page-illus-img">
        <!-- Audit log illustration -->
        <svg width="160" height="80" viewBox="0 0 160 80" fill="none" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;">
          <!-- log book -->
          <rect x="20" y="8" width="70" height="64" rx="6" fill="rgba(36,34,27,.35)" stroke="rgba(242,208,78,0.3)" stroke-width="1.2" style="animation:floatY 3.8s ease-in-out infinite;"/>
          <rect x="20" y="8" width="10" height="64" rx="5" fill="rgba(242,208,78,0.15)" stroke="rgba(242,208,78,0.3)" stroke-width="1"/>
          <!-- log lines with status dots -->
          <circle cx="38" cy="23" r="3" fill="rgba(242,208,78,0.7)" style="animation:pulse-dot 1.5s ease-in-out infinite;"/>
          <rect x="44" y="21" width="36" height="3" rx="1.5" fill="rgba(242,208,78,0.35)"/>
          <rect x="44" y="26" width="26" height="2" rx="1" fill="rgba(242,208,78,0.18)"/>
          <line x1="36" y1="33" x2="84" y2="33" stroke="rgba(242,208,78,0.1)" stroke-width=".8"/>
          <circle cx="38" cy="40" r="3" fill="rgba(100,181,246,.6)"/>
          <rect x="44" y="38" width="30" height="3" rx="1.5" fill="rgba(100,181,246,0.3)"/>
          <rect x="44" y="43" width="20" height="2" rx="1" fill="rgba(100,181,246,0.15)"/>
          <line x1="36" y1="50" x2="84" y2="50" stroke="rgba(242,208,78,0.1)" stroke-width=".8"/>
          <circle cx="38" cy="57" r="3" fill="rgba(255,95,95,.55)"/>
          <rect x="44" y="55" width="34" height="3" rx="1.5" fill="rgba(255,95,95,0.25)"/>
          <rect x="44" y="60" width="22" height="2" rx="1" fill="rgba(255,95,95,0.15)"/>
          <line x1="36" y1="67" x2="84" y2="67" stroke="rgba(242,208,78,0.1)" stroke-width=".8"/>
          <!-- search glass -->
          <circle cx="118" cy="38" r="18" fill="rgba(242,208,78,0.08)" stroke="rgba(242,208,78,0.3)" stroke-width="1.5" style="animation:floatY 4.2s ease-in-out infinite;animation-delay:.8s;"/>
          <circle cx="116" cy="36" r="9" fill="none" stroke="rgba(242,208,78,0.5)" stroke-width="1.5"/>
          <line x1="122" y1="43" x2="130" y2="51" stroke="rgba(242,208,78,0.5)" stroke-width="2" stroke-linecap="round"/>
          <!-- scan line animation -->
          <line x1="109" y1="36" x2="123" y2="36" stroke="rgba(242,208,78,0.3)" stroke-width="1" style="animation:dataStream 1.5s ease-in-out infinite;"/>
          <!-- result rings -->
          <circle cx="118" cy="38" r="22" fill="none" stroke="rgba(242,208,78,0.1)" stroke-width="1" style="animation:ringExpand 3s ease-out infinite;"/>
        </svg>
      </div>
    </div>
    <div class="card">
      <div class="flex items-center justify-between mb-2">
        <div class="card-title" style="margin-bottom:0;">
          <span class="card-title-icon"><svg width="12" height="12"><use href="#ic-audit"/></svg></span>
          Audit Log
        </div>
        <div style="display:flex;gap:8px;">
          <div class="input-wrap" style="max-width:240px;">
            <span class="icon"><svg width="14" height="14"><use href="#ic-search"/></svg></span>
            <input type="text" placeholder="Search..." id="audit-search" oninput="renderAuditLog()">
          </div>
          <select class="form-input" style="width:140px;padding-left:10px;" id="audit-filter" onchange="renderAuditLog()">
            <option value="">All Statuses</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="canceled">Canceled</option>
            <option value="in_progress">In Progress</option>
          </select>
        </div>
      </div>
      <div style="overflow-x:auto;">
        <table>
          <thead><tr>
        <th><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;opacity:.8"><use href="#ic-hash"/></svg>ID</th>
        <th><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;opacity:.8"><use href="#ic-workflow"/></svg>Workflow</th>
        <th><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;opacity:.8"><use href="#ic-version"/></svg>Ver</th>
        <th><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;opacity:.8"><use href="#ic-active"/></svg>Status</th>
        <th><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;opacity:.8"><use href="#ic-trigger"/></svg>Triggered By</th>
        <th><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;opacity:.8"><use href="#ic-calendar"/></svg>Start</th>
        <th><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;opacity:.8"><use href="#ic-clock"/></svg>End</th>
        <th><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;opacity:.8"><use href="#ic-settings"/></svg>Actions</th>
      </tr></thead>
          <tbody id="audit-table-body"></tbody>
        </table>
      </div>
      <div id="audit-empty" class="empty-state" style="display:none;">
        <div style="margin:0 auto 14px;width:110px;height:72px;opacity:.65;">
          <svg viewBox="0 0 110 72" fill="none">
            <rect x="20" y="5" width="50" height="62" rx="6" fill="rgba(242,208,78,0.06)" stroke="rgba(242,208,78,0.2)" stroke-width="1.2" stroke-dasharray="5 3" style="animation:floatY 4s ease-in-out infinite;"/>
            <rect x="20" y="5" width="8" height="62" rx="4" fill="rgba(242,208,78,0.1)"/>
            <rect x="34" y="16" width="28" height="3" rx="1.5" fill="rgba(242,208,78,0.2)"/>
            <rect x="34" y="22" width="20" height="2" rx="1" fill="rgba(242,208,78,0.12)"/>
            <rect x="34" y="30" width="28" height="3" rx="1.5" fill="rgba(242,208,78,0.15)"/>
            <rect x="34" y="36" width="16" height="2" rx="1" fill="rgba(242,208,78,0.1)"/>
            <rect x="34" y="44" width="28" height="3" rx="1.5" fill="rgba(242,208,78,0.12)"/>
            <circle cx="84" cy="38" r="16" fill="rgba(242,208,78,0.06)" stroke="rgba(242,208,78,0.2)" stroke-width="1.2" stroke-dasharray="4 3"/>
            <circle cx="82" cy="36" r="7" fill="none" stroke="rgba(242,208,78,0.3)" stroke-width="1.5"/>
            <line x1="87" y1="41" x2="93" y2="47" stroke="rgba(242,208,78,0.3)" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </div>
        <div class="title">No executions yet</div>
        <div class="sub">Run a workflow to see execution history here</div>
      </div>
    </div>
  </div>
</div>

<div class="toast-container" id="toast-container"></div>

<!-- ── MODALS ── -->
<div class="modal-overlay" id="modal-workflow">
  <div class="modal">
    <div class="modal-header">
      <div class="modal-title-wrap">
        <div class="modal-title-icon"><svg width="16" height="16"><use href="#ic-workflow"/></svg></div>
        <div class="modal-title" id="wf-modal-title">Create Workflow</div>
      </div>
      <button class="modal-close" onclick="closeModal('modal-workflow')"><svg width="12" height="12"><use href="#ic-close"/></svg></button>
    </div>
    <div class="form-row"><label class="form-label"><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;"><use href="#ic-tag"/></svg>Name *</label><input type="text" class="form-input" id="modal-wf-name" placeholder="e.g. Expense Approval"></div>
    <div class="form-row"><label class="form-label"><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;"><use href="#ic-info"/></svg>Description</label><input type="text" class="form-input" id="modal-wf-desc" placeholder="Optional description"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal('modal-workflow')">Cancel</button>
      <button class="btn btn-primary" onclick="saveWorkflowModal()">
        <svg width="13" height="13"><use href="#ic-check"/></svg>
        Create
      </button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="modal-step">
  <div class="modal">
    <div class="modal-header">
      <div class="modal-title-wrap">
        <div class="modal-title-icon"><svg width="16" height="16"><use href="#ic-task"/></svg></div>
        <div class="modal-title" id="step-modal-title">Add Step</div>
      </div>
      <button class="modal-close" onclick="closeModal('modal-step')"><svg width="12" height="12"><use href="#ic-close"/></svg></button>
    </div>
    <div class="form-row"><label class="form-label"><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;"><use href="#ic-tag"/></svg>Step Name *</label><input type="text" class="form-input" id="modal-step-name" placeholder="e.g. Manager Approval"></div>
    <div class="form-row"><label class="form-label"><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;"><use href="#ic-layers"/></svg>Step Type *</label>
      <select class="form-input" id="modal-step-type">
        <option value="task">⚙ Task</option>
        <option value="approval">★ Approval</option>
        <option value="notification">🔔 Notification</option>
      </select>
    </div>
    <div class="form-row"><label class="form-label"><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;"><use href="#ic-email"/></svg>Assignee Email</label><input type="text" class="form-input" id="modal-step-assignee" placeholder="manager@example.com"></div>
    <div class="form-row"><label class="form-label"><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;"><use href="#ic-info"/></svg>Instructions</label><textarea class="form-input" id="modal-step-instructions" rows="3" placeholder="Step instructions..."></textarea></div>
    <input type="hidden" id="modal-step-id">
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal('modal-step')">Cancel</button>
      <button class="btn btn-primary" onclick="saveStepModal()">
        <svg width="13" height="13"><use href="#ic-check"/></svg>
        Save Step
      </button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="modal-rule">
  <div class="modal">
    <div class="modal-header">
      <div class="modal-title-wrap">
        <div class="modal-title-icon"><svg width="16" height="16"><use href="#ic-rule"/></svg></div>
        <div class="modal-title" id="rule-modal-title">Add Rule</div>
      </div>
      <button class="modal-close" onclick="closeModal('modal-rule')"><svg width="12" height="12"><use href="#ic-close"/></svg></button>
    </div>
    <div class="form-row">
      <label class="form-label"><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;"><use href="#ic-filter"/></svg>Priority *</label>
      <input type="number" class="form-input" id="modal-rule-priority" min="1" value="1">
      <div class="form-hint">Lower number = higher priority.</div>
    </div>
    <div class="form-row">
      <label class="form-label"><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;"><use href="#ic-rule"/></svg>Condition *</label>
      <input type="text" class="form-input" id="modal-rule-condition" placeholder="e.g. amount > 100 && country == 'US'  or  DEFAULT">
      <div class="form-hint">Use DEFAULT to catch unmatched cases.</div>
    </div>
    <div class="form-row">
      <label class="form-label"><svg width="11" height="11" style="vertical-align:middle;margin-right:3px;"><use href="#ic-arrow-right"/></svg>Next Step</label>
      <select class="form-input" id="modal-rule-next"><option value="">End Workflow</option></select>
    </div>
    <input type="hidden" id="modal-rule-id">
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal('modal-rule')">Cancel</button>
      <button class="btn btn-primary" onclick="saveRuleModal()">
        <svg width="13" height="13"><use href="#ic-check"/></svg>
        Save Rule
      </button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="modal-schema">
  <div class="modal">
    <div class="modal-header">
      <div class="modal-title-wrap">
        <div class="modal-title-icon"><svg width="16" height="16"><use href="#ic-schema"/></svg></div>
        <div class="modal-title">Schema Field</div>
      </div>
      <button class="modal-close" onclick="closeModal('modal-schema')"><svg width="12" height="12"><use href="#ic-close"/></svg></button>
    </div>
    <div class="form-row"><label class="form-label">Field Name *</label><input type="text" class="form-input" id="modal-field-name" placeholder="e.g. amount"></div>
    <div class="form-row"><label class="form-label">Type *</label>
      <select class="form-input" id="modal-field-type">
        <option value="string">string</option>
        <option value="number">number</option>
        <option value="boolean">boolean</option>
      </select>
    </div>
    <div class="form-row">
      <label class="form-label" style="display:flex;align-items:center;gap:8px;">
        Required <div class="toggle on" id="field-required-toggle" onclick="this.classList.toggle('on')"></div>
      </label>
    </div>
    <div class="form-row">
      <label class="form-label">Allowed Values (optional)</label>
      <input type="text" class="form-input" id="modal-field-allowed-input" placeholder="Type value and press Enter" onkeydown="addAllowedVal(event)">
      <div class="allowed-vals" id="allowed-vals-container"></div>
    </div>
    <input type="hidden" id="modal-field-key">
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal('modal-schema')">Cancel</button>
      <button class="btn btn-primary" onclick="saveSchemaField()">
        <svg width="13" height="13"><use href="#ic-check"/></svg>
        Save Field
      </button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="modal-exec-logs">
  <div class="modal" style="width:660px;max-width:97vw;">
    <div class="modal-header">
      <div class="modal-title-wrap">
        <div class="modal-title-icon"><svg width="16" height="16"><use href="#ic-log"/></svg></div>
        <div class="modal-title" id="exec-logs-modal-title">Execution Logs</div>
      </div>
      <button class="modal-close" onclick="closeModal('modal-exec-logs')"><svg width="12" height="12"><use href="#ic-close"/></svg></button>
    </div>
    <div id="exec-logs-modal-body"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal('modal-exec-logs')">Close</button>
    </div>
  </div>
</div>

<script>
// ── Clock ──
function updateClock() {
  const now = new Date();
  const el = document.getElementById('topbar-clock');
  if (el) el.textContent = now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
setInterval(updateClock, 1000); updateClock();

// ── ID REGISTRY ──
const _reg = {};
function reg(val) { const k = 'r' + Math.random().toString(36).slice(2); _reg[k] = val; return k; }
function get(k) { return _reg[k]; }

const API = {
  async req(method, path, body) {
    const opts = { method, headers: {'Content-Type':'application/json'} };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch('/api' + path, opts);
    if (!r.ok) { const e = await r.json().catch(() => ({error: r.statusText})); throw new Error(e.error || r.statusText); }
    return r.json();
  },
  get: p => API.req('GET', p),
  post: (p,b) => API.req('POST', p, b),
  put: (p,b) => API.req('PUT', p, b),
  del: p => API.req('DELETE', p),
};

let currentWorkflowId = null, currentStepId = null, currentExecId = null;
let allowedVals = [], wfStepsCache = [];

function eid(id) { return id ? String(id).substring(0,8)+'...' : '-'; }
function fmt(iso) { if (!iso) return '-'; try { return new Date(iso).toLocaleString(); } catch(e) { return iso; } }
function fmtShort(iso) { if (!iso) return '-'; try { const d = new Date(iso); return d.toLocaleDateString()+' '+d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); } catch(e) { return iso; } }
function dur(s,e) { if (!s||!e) return ''; const ms=new Date(e)-new Date(s),sec=Math.floor(ms/1000); return sec<60?sec+'s':Math.floor(sec/60)+'m '+sec%60+'s'; }
function esc(v) { return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function toast(msg, type='info') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  const iconId = type === 'success' ? 'ic-check' : type === 'error' ? 'ic-cancel' : 'ic-bolt';
  const color = type === 'success' ? 'var(--green)' : type === 'error' ? 'var(--red)' : 'var(--text-1)';
  t.innerHTML = '<span style="color:' + color + ';display:flex;"><svg width="14" height="14"><use href="#' + iconId + '"/></svg></span><span>' + esc(msg) + '</span>';
  document.getElementById('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function toggleLog(id) { const el = document.getElementById(id); if(el) el.classList.toggle('open'); }

// Page icon map
const PAGE_ICONS = {
  dashboard: 'ic-dashboard',
  workflows: 'ic-workflow',
  editor: 'ic-edit',
  rules: 'ic-rule',
  executions: 'ic-run',
  audit: 'ic-audit',
};

document.addEventListener('click', function(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const k = btn.dataset.k;
  const rid = k ? get(k) : btn.dataset.id;
  if (action === 'load-editor') loadEditor(rid);
  else if (action === 'quick-execute') quickExecute(rid);
  else if (action === 'delete-workflow') deleteWorkflow(rid);
  else if (action === 'open-rules') openRuleEditor(rid);
  else if (action === 'edit-step') openStepModal(rid);
  else if (action === 'delete-step') deleteStep(rid);
  else if (action === 'edit-rule') openRuleModal(rid);
  else if (action === 'delete-rule') deleteRule(rid);
  else if (action === 'edit-schema') openSchemaModal(rid);
  else if (action === 'delete-schema') deleteSchemaField(rid);
  else if (action === 'view-logs') viewExecLogs(rid);
  else if (action === 'audit-retry') retryFromAudit(rid);
  else if (action === 'modal-retry') retryFromAudit(btn.dataset.execId);
});

function navigate(page) {
  // Animate page switch
  const pg = document.getElementById('page-' + page);
  if (pg) { pg.style.opacity = '0'; setTimeout(() => { pg.style.transition = 'opacity .2s ease'; pg.style.opacity = '1'; }, 10); }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const titles = { dashboard:'dashboard', workflows:'workflows', editor:'workflow editor', rules:'rule editor', executions:'run workflow', audit:'audit log' };
  document.getElementById('page-title').innerHTML = titles[page] || page;
  const iconEl = document.getElementById('topbar-page-icon');
  const iconId = PAGE_ICONS[page] || 'ic-bolt';
  iconEl.innerHTML = '<svg width="14" height="14"><use href="#' + iconId + '"/></svg>';
  const navMap = { dashboard:0, workflows:1, executions:2, audit:3 };
  const navItems = document.querySelectorAll('.nav-item');
  if (navMap[page] !== undefined) navItems[navMap[page]]?.classList.add('active');
  if (page === 'dashboard') renderDashboard();
  if (page === 'workflows') renderWorkflowList();
  if (page === 'executions') renderExecutionPage();
  if (page === 'audit') renderAuditLog();
}

function goBackToEditor() { navigate('editor'); loadEditor(currentWorkflowId); }

// ── DASHBOARD ──
async function renderDashboard() {
  try {
    const stats = await API.get('/stats');
    const successRate = stats.executions > 0 ? Math.round(stats.completed/stats.executions*100) : 0;
    document.getElementById('stats-row').innerHTML =
      '<div class="stat-card"><div class="stat-card-header"><div class="stat-icon-wrap green"><svg width="18" height="18"><use href="#ic-layers"/></svg></div><span class="stat-trend neutral"><svg width="9" height="9" style="vertical-align:middle;"><use href="#ic-filter"/></svg> ALL</span></div><div class="stat-label"><svg width="10" height="10" style="vertical-align:middle;margin-right:3px;opacity:.6"><use href="#ic-workflow"/></svg>Workflows</div><div class="stat-value">' + stats.workflows + '</div><div style="font-size:.7rem;color:#8A7A60;font-family:var(--font-mono);margin-top:4px;display:flex;align-items:center;gap:3px;"><svg width="10" height="10"><use href="#ic-info"/></svg>registered blueprints</div></div>' +
      '<div class="stat-card"><div class="stat-card-header"><div class="stat-icon-wrap blue"><svg width="18" height="18"><use href="#ic-zap"/></svg></div><span class="stat-trend neutral"><svg width="9" height="9" style="vertical-align:middle;"><use href="#ic-clock"/></svg> ALL TIME</span></div><div class="stat-label"><svg width="10" height="10" style="vertical-align:middle;margin-right:3px;opacity:.6"><use href="#ic-run"/></svg>Executions</div><div class="stat-value blue">' + stats.executions + '</div><div style="font-size:.7rem;color:#8A7A60;font-family:var(--font-mono);margin-top:4px;display:flex;align-items:center;gap:3px;"><svg width="10" height="10"><use href="#ic-trigger"/></svg>total runs</div></div>' +
      '<div class="stat-card"><div class="stat-card-header"><div class="stat-icon-wrap green"><svg width="18" height="18"><use href="#ic-check-circle"/></svg></div><span class="stat-trend up"><svg width="9" height="9" style="vertical-align:middle;"><use href="#ic-success"/></svg> ' + successRate + '%</span></div><div class="stat-label"><svg width="10" height="10" style="vertical-align:middle;margin-right:3px;opacity:.6"><use href="#ic-check"/></svg>Completed</div><div class="stat-value green">' + stats.completed + '</div><div style="font-size:.7rem;color:#8A7A60;font-family:var(--font-mono);margin-top:4px;display:flex;align-items:center;gap:3px;"><svg width="10" height="10"><use href="#ic-success"/></svg>success rate ' + successRate + '%</div></div>' +
      '<div class="stat-card"><div class="stat-card-header"><div class="stat-icon-wrap ' + (stats.failed > 0 ? 'red' : 'green') + '"><svg width="18" height="18"><use href="#' + (stats.failed > 0 ? 'ic-warning' : 'ic-check-circle') + '"/></svg></div><span class="stat-trend ' + (stats.failed > 0 ? 'up' : 'neutral') + '"><svg width="9" height="9" style="vertical-align:middle;"><use href="#' + (stats.failed > 0 ? 'ic-warning' : 'ic-success') + '"/></svg> ' + (stats.failed > 0 ? 'ACTION' : 'CLEAR') + '</span></div><div class="stat-label"><svg width="10" height="10" style="vertical-align:middle;margin-right:3px;opacity:.6"><use href="#ic-failed"/></svg>Failed</div><div class="stat-value ' + (stats.failed > 0 ? 'red' : '') + '">' + stats.failed + '</div><div style="font-size:.7rem;color:#8A7A60;font-family:var(--font-mono);margin-top:4px;display:flex;align-items:center;gap:3px;"><svg width="10" height="10"><use href="#' + (stats.failed > 0 ? 'ic-warning' : 'ic-info') + '"/></svg>' + (stats.failed > 0 ? 'needs attention' : 'all clear') + '</div></div>';

    const [execRes, wfRes] = await Promise.all([API.get('/executions?limit=5'), API.get('/workflows')]);
    const wfMap = {}; (wfRes.data || []).forEach(w => wfMap[w.id||w._id] = w.name);
    const execs = execRes.data || [];
    const recentEl = document.getElementById('dashboard-recent');
    if (!execs.length) { recentEl.innerHTML = '<div class="text-muted" style="padding:16px 0;">No executions yet.</div>'; }
    else {
      recentEl.innerHTML = '<div style="overflow-x:auto;"><table><thead><tr><th>ID</th><th>Workflow</th><th>Status</th><th>Started</th><th>Duration</th></tr></thead><tbody>' +
        execs.map(e => '<tr><td class="uuid-cell">' + eid(e.id||e._id) + '</td><td style="font-weight:600;">' + esc(wfMap[e.workflow_id]||'-') + '</td><td><span class="badge badge-' + e.status + '">' + e.status.replace('_',' ') + '</span></td><td style="font-family:var(--font-mono);font-size:.75rem;">' + fmtShort(e.started_at) + '</td><td style="font-family:var(--font-mono);font-size:.75rem;">' + (dur(e.started_at, e.ended_at)||'-') + '</td></tr>').join('') +
        '</tbody></table></div>';
    }

    const qwEl = document.getElementById('quick-workflows');
    const active = (wfRes.data || []).filter(w => w.is_active).slice(0, 5);
    if (!active.length) { qwEl.innerHTML = '<div class="text-muted">No active workflows.</div>'; return; }
    qwEl.innerHTML = '';
    active.forEach(w => {
      const id = w.id || w._id;
      const k = reg(id);
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost btn-sm';
      btn.dataset.action = 'quick-execute';
      btn.dataset.k = k;
      btn.innerHTML = '<svg width="13" height="13"><use href="#ic-zap"/></svg> ' + esc(w.name);
      btn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';
      qwEl.appendChild(btn);
    });
  } catch(e) { toast('Dashboard error: ' + e.message, 'error'); }
}

// ── WORKFLOWS ──
async function renderWorkflowList() {
  const search = document.getElementById('workflow-search')?.value || '';
  const status = document.getElementById('workflow-filter')?.value || '';
  try {
    const res = await API.get('/workflows?search=' + encodeURIComponent(search) + '&status=' + status);
    const list = res.data || [];
    const tbody = document.getElementById('workflow-table-body');
    const empty = document.getElementById('workflow-empty');
    if (!list.length) { tbody.innerHTML = ''; empty.style.display = ''; return; }
    empty.style.display = 'none';
    tbody.innerHTML = '';
    list.forEach(wf => {
      const id = wf.id || wf._id;
      const k1 = reg(id), k2 = reg(id), k3 = reg(id);
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="uuid-cell" title="' + esc(id) + '">' + eid(id) + '</td>' +
        '<td><div style="display:flex;align-items:center;gap:8px;"><div class="wf-icon"><svg width="14" height="14"><use href="#ic-workflow"/></svg></div><div><div class="wf-name-cell" style="font-weight:700;">' + esc(wf.name) + '</div>' + (wf.description ? '<div class="wf-desc-cell" style="font-size:.76rem;margin-top:1px;font-family:var(--font-mono);">' + esc(wf.description) + '</div>' : '') + '</div></div></td>' +
        '<td><div style="display:flex;align-items:center;gap:4px;font-family:var(--font-mono);font-weight:700;" class="wf-step-cell"><svg width="12" height="12" style="opacity:.6;"><use href="#ic-task"/></svg>' + (wf.step_count || 0) + '</div></td>' +
        '<td class="wf-version-cell" style="font-family:var(--font-mono);font-weight:700;">v' + wf.version + '</td>' +
        '<td><span class="badge badge-' + (wf.is_active ? 'active' : 'inactive') + '">' + (wf.is_active ? 'active' : 'inactive') + '</span></td>' +
        '<td><div class="actions-cell">' +
          '<button class="btn btn-ghost btn-xs" data-action="load-editor" data-k="' + k1 + '"><svg width="11" height="11" style="vertical-align:middle;"><use href="#ic-edit"/></svg> Edit</button>' +
          '<button class="btn btn-primary btn-xs" data-action="quick-execute" data-k="' + k2 + '"><svg width="11" height="11" style="vertical-align:middle;"><use href="#ic-run"/></svg> Run</button>' +
          '<button class="btn btn-danger btn-xs" data-action="delete-workflow" data-k="' + k3 + '"><svg width="11" height="11" style="vertical-align:middle;"><use href="#ic-delete"/></svg></button>' +
        '</div></td>';
      tbody.appendChild(tr);
    });
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

function openWorkflowModal(id) {
  document.getElementById('modal-wf-name').value = '';
  document.getElementById('modal-wf-desc').value = '';
  document.getElementById('modal-wf-name').dataset.editId = id || '';
  document.getElementById('wf-modal-title').textContent = id ? 'Edit Workflow' : 'Create Workflow';
  openModal('modal-workflow');
}

async function saveWorkflowModal() {
  const name = document.getElementById('modal-wf-name').value.trim();
  if (!name) { toast('Name required', 'error'); return; }
  const editId = document.getElementById('modal-wf-name').dataset.editId;
  try {
    if (editId) await API.put('/workflows/' + editId, { name, description: document.getElementById('modal-wf-desc').value.trim() });
    else await API.post('/workflows', { name, description: document.getElementById('modal-wf-desc').value.trim() });
    toast('Saved', 'success'); closeModal('modal-workflow'); renderWorkflowList();
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteWorkflow(id) {
  if (!confirm('Delete this workflow and all its steps/rules?')) return;
  try { await API.del('/workflows/' + id); toast('Deleted', 'success'); renderWorkflowList(); } catch(e) { toast(e.message, 'error'); }
}

async function saveWorkflow() {
  if (!currentWorkflowId) return;
  try {
    const wf = await API.put('/workflows/' + currentWorkflowId, {
      name: document.getElementById('wf-name').value.trim(),
      description: document.getElementById('wf-desc').value.trim(),
      is_active: document.getElementById('wf-active-toggle').classList.contains('on'),
    });
    document.getElementById('editor-breadcrumb-name').textContent = wf.name;
    toast('Saved', 'success');
  } catch(e) { toast(e.message, 'error'); }
}

async function loadEditor(id) {
  currentWorkflowId = id;
  try {
    const wf = await API.get('/workflows/' + id);
    document.getElementById('editor-breadcrumb-name').textContent = wf.name;
    const illustName = document.getElementById('editor-illus-name'); if(illustName) illustName.textContent = wf.name;
    document.getElementById('wf-name').value = wf.name;
    document.getElementById('wf-desc').value = wf.description || '';
    document.getElementById('wf-active-toggle').classList.toggle('on', wf.is_active);
    navigate('editor');
    renderStepsList(wf.steps || []);
    renderSchemaList(wf.input_schema || {});
  } catch(e) { toast(e.message, 'error'); }
}

// ── SCHEMA ──
function openSchemaModal(key) {
  allowedVals = [];
  document.getElementById('modal-field-name').value = key || '';
  document.getElementById('modal-field-type').value = 'string';
  document.getElementById('field-required-toggle').classList.add('on');
  document.getElementById('modal-field-allowed-input').value = '';
  document.getElementById('allowed-vals-container').innerHTML = '';
  document.getElementById('modal-field-key').value = key || '';
  if (key) {
    API.get('/workflows/' + currentWorkflowId).then(wf => {
      const f = wf.input_schema[key]; if (!f) return;
      document.getElementById('modal-field-type').value = f.type;
      document.getElementById('field-required-toggle').classList.toggle('on', f.required);
      if (f.allowed_values) { allowedVals = [...f.allowed_values]; renderAllowedVals(); }
    });
  }
  openModal('modal-schema');
}

function addAllowedVal(e) {
  if (e.key !== 'Enter') return; e.preventDefault();
  const v = document.getElementById('modal-field-allowed-input').value.trim();
  if (v && !allowedVals.includes(v)) { allowedVals.push(v); renderAllowedVals(); }
  document.getElementById('modal-field-allowed-input').value = '';
}

function renderAllowedVals() {
  const c = document.getElementById('allowed-vals-container'); c.innerHTML = '';
  allowedVals.forEach((v, i) => {
    const span = document.createElement('span'); span.className = 'allowed-tag';
    span.textContent = v;
    const btn = document.createElement('button'); btn.textContent = '×';
    btn.onclick = () => { allowedVals.splice(i, 1); renderAllowedVals(); };
    span.appendChild(btn); c.appendChild(span);
  });
}

async function saveSchemaField() {
  const name = document.getElementById('modal-field-name').value.trim();
  if (!name) { toast('Field name required', 'error'); return; }
  try {
    const wf = await API.get('/workflows/' + currentWorkflowId);
    const schema = { ...(wf.input_schema || {}) };
    const oldKey = document.getElementById('modal-field-key').value;
    if (oldKey && oldKey !== name) delete schema[oldKey];
    schema[name] = {
      type: document.getElementById('modal-field-type').value,
      required: document.getElementById('field-required-toggle').classList.contains('on'),
      ...(allowedVals.length ? { allowed_values: [...allowedVals] } : {})
    };
    await API.put('/workflows/' + currentWorkflowId, { input_schema: schema });
    closeModal('modal-schema'); renderSchemaList(schema); toast('Field saved', 'success');
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteSchemaField(key) {
  try {
    const wf = await API.get('/workflows/' + currentWorkflowId);
    const schema = { ...(wf.input_schema || {}) }; delete schema[key];
    await API.put('/workflows/' + currentWorkflowId, { input_schema: schema });
    renderSchemaList(schema);
  } catch(e) { toast(e.message, 'error'); }
}

function renderSchemaList(schema) {
  const keys = Object.keys(schema || {});
  const el = document.getElementById('schema-list');
  const empty = document.getElementById('schema-empty');
  if (!keys.length) { el.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';
  el.innerHTML = '';
  keys.forEach(k => {
    const f = schema[k];
    const row = document.createElement('div');
    row.className = 'schema-field-row';
    const k1 = reg(k), k2 = reg(k);
    row.innerHTML =
      '<span style="font-weight:600;font-family:var(--font-mono);font-size:.8rem;color:var(--text-0);">' + esc(k) + '</span>' +
      '<span class="badge" style="font-size:.68rem;background:var(--bg-3);color:var(--text-2);border:1px solid var(--border-0);">' + esc(f.type) + '</span>' +
      '<span class="badge badge-' + (f.required ? 'active' : 'inactive') + '" style="font-size:.65rem;">' + (f.required ? 'req' : 'opt') + '</span>' +
      '<div style="display:flex;gap:3px;">' +
        '<button class="btn btn-ghost btn-xs" data-action="edit-schema" data-k="' + k1 + '"><svg width="11" height="11"><use href="#ic-edit"/></svg></button>' +
        '<button class="btn btn-danger btn-xs" data-action="delete-schema" data-k="' + k2 + '"><svg width="11" height="11"><use href="#ic-delete"/></svg></button>' +
      '</div>';
    el.appendChild(row);
    if (f.allowed_values) {
      const av = document.createElement('div');
      av.style.gridColumn = '1/-1'; av.style.paddingBottom = '4px';
      const wrap = document.createElement('div'); wrap.className = 'allowed-vals';
      f.allowed_values.forEach(v => { const s = document.createElement('span'); s.className = 'allowed-tag'; s.textContent = v; wrap.appendChild(s); });
      av.appendChild(wrap); el.appendChild(av);
    }
  });
}

// ── STEPS ──
const STEP_ICON_MAP = { task: 'ic-task', approval: 'ic-approval', notification: 'ic-notification' };

function openStepModal(id) {
  document.getElementById('modal-step-name').value = '';
  document.getElementById('modal-step-type').value = 'task';
  document.getElementById('modal-step-assignee').value = '';
  document.getElementById('modal-step-instructions').value = '';
  document.getElementById('modal-step-id').value = id || '';
  document.getElementById('step-modal-title').textContent = id ? 'Edit Step' : 'Add Step';
  if (id) {
    const s = wfStepsCache.find(s => (s.id||s._id) === id);
    if (s) {
      document.getElementById('modal-step-name').value = s.name;
      document.getElementById('modal-step-type').value = s.step_type;
      document.getElementById('modal-step-assignee').value = s.metadata?.assignee_email || '';
      document.getElementById('modal-step-instructions').value = s.metadata?.instructions || '';
    }
  }
  openModal('modal-step');
}

async function saveStepModal() {
  const name = document.getElementById('modal-step-name').value.trim();
  if (!name) { toast('Step name required', 'error'); return; }
  const editId = document.getElementById('modal-step-id').value;
  const body = { name, step_type: document.getElementById('modal-step-type').value, metadata: { assignee_email: document.getElementById('modal-step-assignee').value.trim(), instructions: document.getElementById('modal-step-instructions').value.trim() } };
  try {
    if (editId) await API.put('/steps/' + editId, body);
    else await API.post('/workflows/' + currentWorkflowId + '/steps', body);
    toast(editId ? 'Step updated' : 'Step added', 'success');
    closeModal('modal-step');
    const steps = await API.get('/workflows/' + currentWorkflowId + '/steps');
    renderStepsList(steps);
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteStep(id) {
  if (!confirm('Delete this step and its rules?')) return;
  try {
    await API.del('/steps/' + id);
    const steps = await API.get('/workflows/' + currentWorkflowId + '/steps');
    renderStepsList(steps); toast('Step deleted', 'success');
  } catch(e) { toast(e.message, 'error'); }
}

function renderStepsList(steps) {
  wfStepsCache = steps;
  const el = document.getElementById('steps-list');
  const empty = document.getElementById('steps-empty');
  if (!steps.length) { el.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';
  el.innerHTML = '';
  steps.forEach(s => {
    const id = s.id || s._id;
    const k1 = reg(id), k2 = reg(id), k3 = reg(id);
    const iconId = STEP_ICON_MAP[s.step_type] || 'ic-task';
    const card = document.createElement('div'); card.className = 'step-card';
    card.innerHTML =
      '<div class="step-order" title="Step ' + s.order + '">' + s.order + '</div>' +
      '<div class="step-type-icon ' + s.step_type + '"><svg width="15" height="15"><use href="#' + iconId + '"/></svg></div>' +
      '<div class="step-info">' +
        '<div class="step-name">' + esc(s.name) + '</div>' +
        '<div style="margin-top:3px;display:flex;align-items:center;gap:6px;"><span class="badge badge-' + s.step_type + '">' + s.step_type + '</span>' + (s.metadata?.assignee_email ? '<span style="font-size:.72rem;color:#7A7568;font-family:var(--font-mono);display:inline-flex;align-items:center;gap:3px;"><svg width="10" height="10" style="flex-shrink:0;"><use href="#ic-email"/></svg>' + esc(s.metadata.assignee_email) + '</span>' : '') + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:5px;">' +
        '<button class="btn btn-ghost btn-xs" data-action="open-rules" data-k="' + k1 + '"><svg width="11" height="11" style="vertical-align:middle;"><use href="#ic-rule"/></svg> Rules</button>' +
        '<button class="btn btn-ghost btn-xs" data-action="edit-step" data-k="' + k2 + '"><svg width="11" height="11" style="vertical-align:middle;"><use href="#ic-edit"/></svg></button>' +
        '<button class="btn btn-danger btn-xs" data-action="delete-step" data-k="' + k3 + '"><svg width="11" height="11" style="vertical-align:middle;"><use href="#ic-delete"/></svg></button>' +
      '</div>';
    el.appendChild(card);
  });
}

// ── RULES ──
async function openRuleEditor(stepId) {
  currentStepId = stepId;
  const step = wfStepsCache.find(s => (s.id||s._id) === stepId);
  const wf = await API.get('/workflows/' + currentWorkflowId);
  document.getElementById('rule-wf-name').textContent = wf.name;
  document.getElementById('rule-step-name').textContent = step?.name || stepId;
  navigate('rules');
  renderRulesList();
}

async function openRuleModal(id) {
  document.getElementById('modal-rule-id').value = id || '';
  document.getElementById('modal-rule-priority').value = '1';
  document.getElementById('modal-rule-condition').value = '';
  document.getElementById('rule-modal-title').textContent = id ? 'Edit Rule' : 'Add Rule';
  const steps = wfStepsCache.length ? wfStepsCache : await API.get('/workflows/' + currentWorkflowId + '/steps');
  const sel = document.getElementById('modal-rule-next');
  sel.innerHTML = '<option value="">End Workflow</option>';
  steps.forEach(s => { const opt = document.createElement('option'); opt.value = s.id||s._id; opt.textContent = s.name; sel.appendChild(opt); });
  if (id) {
    const rules = await API.get('/steps/' + currentStepId + '/rules');
    const r = rules.find(r => (r.id||r._id) === id);
    if (r) { document.getElementById('modal-rule-priority').value = r.priority; document.getElementById('modal-rule-condition').value = r.condition; sel.value = r.next_step_id || ''; }
  }
  openModal('modal-rule');
}

async function saveRuleModal() {
  const condition = document.getElementById('modal-rule-condition').value.trim();
  if (!condition) { toast('Condition required', 'error'); return; }
  const editId = document.getElementById('modal-rule-id').value;
  const body = { condition, priority: parseInt(document.getElementById('modal-rule-priority').value) || 1, next_step_id: document.getElementById('modal-rule-next').value || null };
  try {
    if (editId) await API.put('/rules/' + editId, body);
    else await API.post('/steps/' + currentStepId + '/rules', body);
    toast('Rule saved', 'success'); closeModal('modal-rule'); renderRulesList();
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteRule(id) {
  try { await API.del('/rules/' + id); renderRulesList(); toast('Rule deleted'); } catch(e) { toast(e.message, 'error'); }
}

async function renderRulesList() {
  try {
    const rules = await API.get('/steps/' + currentStepId + '/rules');
    const steps = wfStepsCache.length ? wfStepsCache : await API.get('/workflows/' + currentWorkflowId + '/steps');
    const stepMap = {}; steps.forEach(s => stepMap[s.id||s._id] = s.name);
    const el = document.getElementById('rules-list');
    const empty = document.getElementById('rules-empty');
    if (!rules.length) { el.innerHTML = ''; empty.style.display = ''; return; }
    empty.style.display = 'none';
    el.innerHTML = '';
    rules.forEach(r => {
      const id = r.id || r._id;
      const k1 = reg(id), k2 = reg(id);
      const isDefault = r.condition.trim().toUpperCase() === 'DEFAULT';
      const next = r.next_step_id ? (stepMap[r.next_step_id] || r.next_step_id) : 'End Workflow';
      const row = document.createElement('div'); row.className = 'rule-row';
      row.innerHTML =
        '<div class="rule-priority" title="Priority ' + r.priority + '" style="display:flex;align-items:center;justify-content:center;flex-direction:column;gap:1px;"><svg width="9" height="9" style="opacity:.6;"><use href="#ic-filter"/></svg><span>' + r.priority + '</span></div>' +
        '<div class="rule-condition' + (isDefault ? ' default' : '') + '" style="display:flex;align-items:center;gap:5px;"><svg width="10" height="10" style="flex-shrink:0;opacity:.6;"><use href="#' + (isDefault ? 'ic-success' : 'ic-rule') + '"/></svg>' + esc(r.condition) + '</div>' +
        '<div style="font-size:.75rem;color:#4A4438;font-family:var(--font-mono);font-weight:600;display:flex;align-items:center;gap:5px;"><svg width="13" height="13" style="color:var(--mustard);"><use href="#ic-arrow-right"/></svg>' + esc(next) + '</div>' +
        '<div style="display:flex;gap:3px;">' +
          '<button class="btn btn-ghost btn-xs" data-action="edit-rule" data-k="' + k1 + '"><svg width="11" height="11"><use href="#ic-edit"/></svg></button>' +
          '<button class="btn btn-danger btn-xs" data-action="delete-rule" data-k="' + k2 + '"><svg width="11" height="11"><use href="#ic-delete"/></svg></button>' +
        '</div>';
      el.appendChild(row);
    });
  } catch(e) { toast(e.message, 'error'); }
}

// ── EXECUTIONS ──
async function renderExecutionPage() {
  try {
    const res = await API.get('/workflows?status=true&limit=100');
    const sel = document.getElementById('exec-workflow-select');
    sel.innerHTML = '<option value="">Choose a workflow...</option>';
    (res.data || []).forEach(w => { const opt = document.createElement('option'); opt.value = w.id||w._id; opt.textContent = w.name; sel.appendChild(opt); });
    document.getElementById('exec-input-fields').innerHTML = '';
    document.getElementById('exec-start-btn').style.display = 'none';
    document.getElementById('exec-progress-card').style.display = 'none';
    const execRes = await API.get('/executions?status=in_progress&limit=1');
    const active = (execRes.data || [])[0];
    if (active) {
      currentExecId = active.id || active._id;
      currentWorkflowId = active.workflow_id;
      sel.value = active.workflow_id;
      const wf = await API.get('/workflows/' + active.workflow_id);
      document.getElementById('exec-progress-card').style.display = '';
      document.getElementById('exec-start-btn').style.display = 'none';
      document.getElementById('exec-input-fields').innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--blue-dim);border-radius:8px;margin-top:8px;border:1px solid rgba(100,181,246,.2);">' +
        '<span style="font-size:.8rem;font-weight:600;color:var(--blue);font-family:var(--font-mono);display:flex;align-items:center;gap:6px;"><svg width="13" height="13"><use href="#ic-retry"/></svg> Resuming in-progress execution</span>' +
        '<button class="btn btn-ghost btn-sm" onclick="resetExecution()"><svg width="12" height="12"><use href="#ic-plus"/></svg> New</button></div>';
      renderExecView(active, wf);
      toast('Resumed in-progress execution', 'success');
    }
  } catch(e) { toast(e.message, 'error'); }
}

async function onExecWorkflowChange() {
  const id = document.getElementById('exec-workflow-select').value;
  document.getElementById('exec-start-btn').style.display = 'none';
  document.getElementById('exec-progress-card').style.display = 'none';
  if (!id) { document.getElementById('exec-input-fields').innerHTML = ''; return; }
  try {
    const wf = await API.get('/workflows/' + id);
    const schema = wf.input_schema || {};
    const fields = Object.keys(schema);
    const container = document.getElementById('exec-input-fields');
    container.innerHTML = '';
    if (fields.length) {
      const div = document.createElement('div'); div.className = 'divider'; container.appendChild(div);
      const lbl = document.createElement('div');
      lbl.style.cssText = 'font-weight:700;font-size:.72rem;margin-bottom:10px;color:var(--text-2);font-family:var(--font-mono);letter-spacing:1.5px;text-transform:uppercase;';
      lbl.textContent = 'Input Data';
      container.appendChild(lbl);
      fields.forEach(k => {
        const f = schema[k];
        const row = document.createElement('div'); row.className = 'form-row';
        const label = document.createElement('label'); label.className = 'form-label';
        label.textContent = k + ' (' + f.type + (f.required ? ', required' : '') + ')';
        row.appendChild(label);
        let inp;
        if (f.allowed_values?.length) {
          inp = document.createElement('select'); inp.className = 'form-input';
          const def = document.createElement('option'); def.value = ''; def.textContent = 'Select...'; inp.appendChild(def);
          f.allowed_values.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; inp.appendChild(o); });
        } else if (f.type === 'boolean') {
          inp = document.createElement('select'); inp.className = 'form-input';
          ['true', 'false'].forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; inp.appendChild(o); });
        } else {
          inp = document.createElement('input');
          inp.type = f.type === 'number' ? 'number' : 'text';
          inp.className = 'form-input';
          inp.placeholder = f.required ? 'Required' : 'Optional';
        }
        inp.id = 'exec-field-' + k;
        row.appendChild(inp);
        container.appendChild(row);
      });
    }
    document.getElementById('exec-start-btn').style.display = '';
  } catch(e) { toast(e.message, 'error'); }
}

async function startExecution() {
  const wfId = document.getElementById('exec-workflow-select').value;
  if (!wfId) { toast('Select a workflow', 'error'); return; }
  try {
    const wf = await API.get('/workflows/' + wfId);
    const data = {};
    for (const k of Object.keys(wf.input_schema || {})) {
      const el = document.getElementById('exec-field-' + k); if (!el) continue;
      const v = el.value.trim(); const f = wf.input_schema[k];
      if (f.required && !v) { toast('Field "' + k + '" is required', 'error'); return; }
      if (f.type === 'number') data[k] = v ? parseFloat(v) : null;
      else if (f.type === 'boolean') data[k] = v === 'true';
      else data[k] = v;
    }
    const exec = await API.post('/workflows/' + wfId + '/execute', { data, triggered_by: 'user-ui' });
    currentExecId = exec.id || exec._id;
    toast('Execution started', 'success');
    document.getElementById('exec-progress-card').style.display = '';
    renderExecView(exec, wf);
  } catch(e) { toast(e.message, 'error'); }
}

async function cancelExecution() {
  if (!currentExecId) return;
  try { const exec = await API.post('/executions/' + currentExecId + '/cancel'); const wf = await API.get('/workflows/' + exec.workflow_id); renderExecView(exec, wf); toast('Canceled'); } catch(e) { toast(e.message, 'error'); }
}

async function retryExecution() {
  if (!currentExecId) return;
  try { const exec = await API.post('/executions/' + currentExecId + '/retry'); const wf = await API.get('/workflows/' + exec.workflow_id); renderExecView(exec, wf); toast('Retrying...', 'success'); } catch(e) { toast(e.message, 'error'); }
}

function _doApprove(dec) { approveStep(dec); }

async function approveStep(decision) {
  if (!currentExecId) return;
  try {
    const exec = await API.post('/executions/' + currentExecId + '/approve', { decision, approver_id: 'user-ui' });
    const fresh = await API.get('/executions/' + currentExecId);
    const wf = await API.get('/workflows/' + exec.workflow_id);
    renderExecView(fresh, wf);
    toast(decision === 'approve' ? '✓ Approved' : '✕ Rejected', decision === 'approve' ? 'success' : 'error');
  } catch(e) { toast(e.message, 'error'); }
}

// ── FLOW DIAGRAM ──
async function renderExecView(exec, wf) {
  const statusBadge = document.getElementById('exec-status-badge');
  statusBadge.textContent = exec.status.replace('_', ' ').toUpperCase();
  statusBadge.className = 'badge badge-' + exec.status;

  document.getElementById('exec-meta').innerHTML =
    '<svg width="12" height="12" style="vertical-align:middle;margin-right:3px;color:var(--mustard);"><use href="#ic-workflow"/></svg>' + esc(wf.name) +
    ' <svg width="10" height="10" style="vertical-align:middle;opacity:.5;margin:0 2px;"><use href="#ic-version"/></svg>v' + exec.workflow_version +
    ' <svg width="10" height="10" style="vertical-align:middle;opacity:.5;margin:0 2px;"><use href="#ic-calendar"/></svg> ' + fmtShort(exec.started_at) +
    (exec.ended_at ? ' <svg width="10" height="10" style="vertical-align:middle;opacity:.5;margin:0 2px;"><use href="#ic-clock"/></svg> ' + fmtShort(exec.ended_at) : '') +
    (exec.retries ? ' <svg width="10" height="10" style="vertical-align:middle;opacity:.5;margin:0 2px;"><use href="#ic-retry"/></svg> ' + exec.retries + ' retries' : '');

  document.getElementById('exec-retry-btn').style.display = 'none';
  document.getElementById('exec-cancel-btn').style.display = exec.status === 'in_progress' ? '' : 'none';

  const steps = wf.steps || await API.get('/workflows/' + (wf._id||wf.id) + '/steps').catch(() => []);
  let progressPct = 0;
  if (exec.status === 'completed') {
    progressPct = 100;
  } else if (exec.status === 'failed' || exec.status === 'canceled') {
    const done = exec.logs.filter(l => l.status === 'completed' || l.status === 'rejected').length;
    progressPct = steps.length ? Math.round(done / steps.length * 100) : 0;
  } else {
    const done = exec.logs.filter(l => l.status === 'completed').length;
    progressPct = steps.length ? Math.round(done / steps.length * 100) : 0;
  }
  document.getElementById('exec-progress-bar').style.width = progressPct + '%';

  const sv = document.getElementById('exec-steps-view');

  // ── Build the full ordered list of "visible" step slots ──
  // For failed: trim steps after last executed. For completed: keep all but focus on last executed.
  const lastExecutedIdx = steps.reduce((acc, s, i) =>
    exec.logs.find(l => l.step_id === (s.id||s._id)) ? i : acc, -1);

  // Build enriched step list — strip steps that were never reached (no log entry)
  // This handles branching flows where some steps are bypassed
  const visibleSteps = [];
  steps.forEach((s, idx) => {
    const hasLog = exec.logs.find(l => l.step_id === (s.id||s._id));
    const isCurrentStep = exec.current_step_id === (s.id||s._id);
    // Always include steps that ran OR are currently active
    // For terminal states, only include steps that actually executed
    if (exec.status === 'in_progress' || exec.status === 'pending') {
      // Always include all steps for in-progress — window will slide to show current
      visibleSteps.push({ type: 'step', data: s });
    } else {
      // completed/failed: only show steps that actually have a log
      if (hasLog) visibleSteps.push({ type: 'step', data: s });
    }
  });

  if (exec.status === 'completed' || exec.status === 'failed') {
    visibleSteps.push({ type: 'terminal', status: exec.status, logs: exec.logs });
  }

  // ── Determine the "focus index" — anchor on the last step that actually ran ──
  let focusIdx = 0;
  if (exec.status === 'completed' || exec.status === 'failed') {
    // Anchor window on last executed step so we never show unvisited steps
    // The terminal node will naturally appear as the last slot
    const lastExecVisIdx = visibleSteps.reduce((acc, vs, i) => {
      if (vs.type === 'step' && exec.logs.find(l => l.step_id === (vs.data.id||vs.data._id))) return i;
      return acc;
    }, 0);
    // Put the terminal as the right edge: focus = terminal index, but clamp window so no pending steps show
    focusIdx = lastExecVisIdx + 1; // +1 = the terminal node index
  } else {
    // In-progress: centre on current step
    const curIdx = visibleSteps.findIndex(vs => vs.type === 'step' && (vs.data.id||vs.data._id) === exec.current_step_id);
    focusIdx = curIdx >= 0 ? curIdx : Math.max(0, visibleSteps.length - 1);
  }

  // ── Sliding window: show 3 cards, terminal always at right edge when done ──
  const WINDOW = 3;
  let winStart, winEnd;
  if (exec.status === 'completed' || exec.status === 'failed') {
    // Pin terminal to right edge, fill left with actually-executed steps
    winEnd = visibleSteps.length;
    winStart = Math.max(0, winEnd - WINDOW);
  } else {
    // Centre around current step
    winStart = Math.max(0, focusIdx - Math.floor(WINDOW / 2));
    winEnd = winStart + WINDOW;
    if (winEnd > visibleSteps.length) { winEnd = visibleSteps.length; winStart = Math.max(0, winEnd - WINDOW); }
  }
  const windowSlots = visibleSteps.slice(winStart, winEnd);

  // Track previous window start for slide direction
  const prevWinStart = sv._prevWinStart !== undefined ? sv._prevWinStart : winStart;
  const slideDirection = winStart > prevWinStart ? 'right' : winStart < prevWinStart ? 'left' : 'none';
  sv._prevWinStart = winStart;

  sv.innerHTML = '';
  const flowWrap = document.createElement('div');
  flowWrap.className = 'flow-diagram';

  // ── Left ellipsis indicator ──
  if (winStart > 0) {
    const ellip = document.createElement('div');
    ellip.style.cssText = 'display:flex;align-items:center;padding-top:30px;flex-shrink:0;opacity:.4;font-size:.75rem;font-family:var(--font-mono);color:var(--text-2);padding-right:6px;';
    ellip.textContent = '···';
    flowWrap.appendChild(ellip);
  }

  windowSlots.forEach((slot, wi) => {
    const globalIdx = winStart + wi;
    const isNewlySlid = slideDirection !== 'none' && (
      (slideDirection === 'right' && wi === windowSlots.length - 1) ||
      (slideDirection === 'left' && wi === 0)
    );

    if (slot.type === 'terminal') {
      // ── Terminal node ──
      const node = document.createElement('div');
      node.className = 'flow-node' + (isNewlySlid ? ' slide-in' : '');

      const isApproverRejection = slot.logs && [...slot.logs].reverse().find(l => l.status === 'rejected');
      const isCompleted = slot.status === 'completed';

      // Check if the last executed step was a "rejection" step by name
      const lastLog = slot.logs && [...slot.logs].reverse().find(l => l.status === 'completed' || l.status === 'rejected');
      const lastStepName = lastLog ? (lastLog.step_name || '').toLowerCase() : '';
      const isTaskRejection = isCompleted && (lastStepName.includes('reject') || lastStepName.includes('denial') || lastStepName.includes('decline'));

      // Determine terminal state: green (approved/completed), red (rejected by approver or routed to rejection step)
      const termIsRed = isApproverRejection || isTaskRejection;
      const termColor = termIsRed ? 'var(--red)' : 'var(--green)';
      const termIcon = termIsRed ? 'ic-cancel' : 'ic-check-circle';
      const termLabel = termIsRed ? (isApproverRejection ? 'Rejected' : 'Task Rejected') : 'Completed';
      const termBadge = termIsRed ? (isApproverRejection ? 'rejected' : 'failed') : 'completed';
      const termBoxClass = termIsRed ? 'failed' : 'done';

      const termBox = document.createElement('div');
      termBox.className = 'flow-step-box ' + termBoxClass;
      if (!termIsRed) termBox.style.cssText = 'border-color:var(--border-green);background:var(--green-dim);';
      termBox.innerHTML =
        '<div class="flow-step-icon"><svg width="28" height="28" style="color:' + termColor + '"><use href="#' + termIcon + '"/></svg></div>' +
        '<div class="flow-step-name" style="color:' + termColor + ';">' + termLabel + '</div>' +
        '<div class="flow-step-type">workflow end</div>' +
        '<div class="flow-step-status"><span class="badge badge-' + termBadge + '" style="font-size:.68rem;padding:2px 8px;">' + (termIsRed ? '✕' : '✓') + '</span></div>';
      node.appendChild(termBox);
      flowWrap.appendChild(node);

    } else {
      // ── Regular step node ──
      const s = slot.data;
      const sid = s.id || s._id;
      const log = exec.logs.find(l => l.step_id === sid);
      const isCurrent = exec.current_step_id === sid;
      let state = 'pending';
      if (log) state = log.status === 'completed' ? 'done' : 'failed';
      if (isCurrent && exec.status === 'in_progress') state = 'current';

      const iconId = STEP_ICON_MAP[s.step_type] || 'ic-task';
      const iconColor = state === 'done' ? 'var(--green)' : state === 'current' ? 'var(--blue)' : state === 'failed' ? 'var(--red)' : 'var(--text-2)';

      const node = document.createElement('div');
      node.className = 'flow-node' + (isNewlySlid ? ' slide-in' : '');

      const box = document.createElement('div');
      box.className = 'flow-step-box ' + state;
      box.innerHTML =
        '<div class="flow-step-icon"><svg width="28" height="28" style="color:' + iconColor + '"><use href="#' + iconId + '"/></svg></div>' +
        '<div class="flow-step-name" title="' + esc(s.name) + '">' + esc(s.name) + '</div>' +
        '<div class="flow-step-type">' + s.step_type + '</div>' +
        '<div class="flow-step-status">' +
          (state === 'current' ? '<span class="spinner"></span>' : '<span class="badge badge-' + (log ? log.status : (isCurrent ? 'in_progress' : 'pending')) + '" style="font-size:.68rem;padding:2px 8px;">' + (state === 'done' ? '✓' : state === 'failed' ? '✕' : '…') + '</span>') +
        '</div>';
      node.appendChild(box);

      if (isCurrent && exec.status === 'in_progress' && s.step_type === 'approval') {
        const apanel = document.createElement('div');
        apanel.style.cssText = 'margin-top:10px;width:100%;max-width:180px;';
        apanel.innerHTML =
          '<div style="display:flex;flex-direction:column;gap:4px;">' +
            '<button class="btn btn-primary btn-sm" data-dec="approve" onclick="_doApprove(this.dataset.dec)" style="width:100%;justify-content:center;"><svg width="13" height="13"><use href="#ic-check"/></svg> Approve</button>' +
            '<button class="btn btn-danger btn-sm" data-dec="reject" onclick="_doApprove(this.dataset.dec)" style="width:100%;justify-content:center;"><svg width="13" height="13"><use href="#ic-close"/></svg> Reject</button>' +
          '</div>';
        node.appendChild(apanel);
      }
      flowWrap.appendChild(node);
    }

    // ── Connector between slots (not after last) ──
    if (wi < windowSlots.length - 1) {
      const curSlot = slot;
      const log = curSlot.type === 'step' ? exec.logs.find(l => l.step_id === ((curSlot.data.id||curSlot.data._id))) : null;
      const isCur = curSlot.type === 'step' && exec.current_step_id === (curSlot.data.id||curSlot.data._id);
      const connState = log && log.status === 'completed' ? 'done' : (isCur ? 'active' : '');
      const conn = document.createElement('div');
      conn.className = 'flow-connector';
      conn.innerHTML = '<div class="flow-connector-line ' + connState + '"></div><div class="flow-connector-arrow' + (connState ? ' ' + connState : '') + '"></div>';
      flowWrap.appendChild(conn);
    }
  });

  // ── Right ellipsis indicator ──
  if (winEnd < visibleSteps.length) {
    const ellip = document.createElement('div');
    ellip.style.cssText = 'display:flex;align-items:center;padding-top:30px;flex-shrink:0;opacity:.4;font-size:.75rem;font-family:var(--font-mono);color:var(--text-2);padding-left:6px;';
    ellip.textContent = '···';
    flowWrap.appendChild(ellip);
  }

  // ── Step counter ──
  const counterEl = document.getElementById('exec-step-counter');
  if (counterEl) {
    const totalReal = steps.length;
    const doneCount = exec.logs.filter(l => l.status === 'completed' || l.status === 'rejected').length;
    if (exec.status === 'completed') counterEl.textContent = 'ALL ' + totalReal + ' STEPS DONE';
    else if (exec.status === 'failed') counterEl.textContent = doneCount + ' / ' + totalReal + ' STEPS · ENDED';
    else counterEl.textContent = 'STEP ' + (doneCount + 1) + ' OF ' + totalReal;
  }

  sv.appendChild(flowWrap);

  const currentStep = steps.find(s => (s.id||s._id) === exec.current_step_id);
  if (currentStep && currentStep.step_type === 'approval' && exec.status === 'in_progress') {
    const panel = document.createElement('div');
    panel.className = 'approval-panel';
    const iconId = STEP_ICON_MAP[currentStep.step_type] || 'ic-approval';
    panel.innerHTML =
      '<div style="width:36px;height:36px;background:var(--blue-dim);border:1px solid rgba(100,181,246,.2);border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--blue);flex-shrink:0;"><svg width="18" height="18"><use href="#' + iconId + '"/></svg></div>' +
      '<div class="approval-info">' +
        '<div>Awaiting approval — <strong>' + esc(currentStep.name) + '</strong></div>' +
        (currentStep.metadata?.assignee_email ? '<div class="approval-sub">Assignee: ' + esc(currentStep.metadata.assignee_email) + '</div>' : '') +
        (currentStep.metadata?.instructions ? '<div class="approval-sub" style="margin-top:4px;">' + esc(currentStep.metadata.instructions) + '</div>' : '') +
      '</div>' +
      '<button class="btn btn-primary" data-dec="approve" onclick="_doApprove(this.dataset.dec)"><svg width="15" height="15"><use href="#ic-check"/></svg> Approve</button>' +
      '<button class="btn btn-danger" data-dec="reject" onclick="_doApprove(this.dataset.dec)"><svg width="15" height="15"><use href="#ic-close"/></svg> Reject</button>';
    sv.appendChild(panel);
  }

  // ── Retry panel — shown when execution failed/rejected ──
  if (exec.status === 'failed') {
    const failedLog = [...exec.logs].reverse().find(l => l.status === 'rejected' || l.status === 'failed');
    const isRejection = failedLog && failedLog.status === 'rejected';
    const failedStepName = failedLog ? failedLog.step_name : 'the failed step';

    const rPanel = document.createElement('div');
    rPanel.className = 'retry-panel';
    rPanel.innerHTML =
      '<div class="retry-panel-icon"><svg width="18" height="18"><use href="#ic-warning"/></svg></div>' +
      '<div class="retry-panel-info">' +
        '<div class="retry-panel-title">' + (isRejection ? 'Accidentally rejected?' : 'Execution failed') + '</div>' +
        '<div class="retry-panel-sub">' + (isRejection ? 'Rejected at <strong style="color:var(--text-1);">' + esc(failedStepName) + '</strong> — retry will reopen that approval step' : 'Failed at <strong style="color:var(--text-1);">' + esc(failedStepName) + '</strong> — retry will re-run from that step') + '</div>' +
      '</div>' +
      '<button class="btn btn-primary" onclick="retryExecution()" style="flex-shrink:0;">' +
        '<svg width="15" height="15"><use href="#ic-retry"/></svg> ' + (isRejection ? 'Re-open Approval' : 'Retry') +
      '</button>';
    sv.appendChild(rPanel);
  }

  // ── LOGS ──
  const lv = document.getElementById('exec-logs-view');
  if (!exec.logs.length) { lv.innerHTML = '<div class="text-muted" style="padding:12px 0;">No logs yet.</div>'; return; }
  lv.innerHTML = '';
  exec.logs.forEach((l, i) => {
    const entry = document.createElement('div'); entry.className = 'log-entry';
    const lid = 'lb-' + i + '-' + Date.now();
    const logIconId = STEP_ICON_MAP[l.step_type] || 'ic-task';
    entry.innerHTML =
      '<div class="log-header" data-lid="' + lid + '" onclick="toggleLog(this.dataset.lid)">' +
        '<div class="log-step-num">' + (i+1) + '</div>' +
        '<div style="display:flex;align-items:center;gap:6px;flex:1;"><svg width="13" height="13" style="color:var(--text-2);"><use href="#' + logIconId + '"/></svg><div class="log-step-title">' + esc(l.step_name) + '</div></div>' +
        '<span class="badge badge-' + l.status + '">' + l.status + '</span>' +
        '<div style="font-size:.7rem;color:var(--text-2);font-family:var(--font-mono);">' + (dur(l.started_at, l.ended_at) || '') + '</div>' +
      '</div>' +
      '<div class="log-body" id="' + lid + '">' +
        (l.evaluated_rules?.length ?
          '<div style="margin-bottom:6px;font-weight:600;font-size:.74rem;color:var(--text-2);font-family:var(--font-mono);letter-spacing:1px;text-transform:uppercase;">Rules Evaluated</div>' +
          l.evaluated_rules.map(r =>
            '<div class="rule-eval-row">' +
              '<span style="color:' + (r.result ? 'var(--green)' : 'var(--red)') + ';font-weight:700;display:flex;"><svg width="13" height="13"><use href="#' + (r.result ? 'ic-check' : 'ic-close') + '"/></svg></span>' +
              '<span class="rule-eval-cond">' + esc(r.rule) + '</span>' +
              '<span style="color:' + (r.result ? 'var(--green)' : 'var(--text-2)') + ';font-weight:600;">' + (r.result ? 'MATCH' : 'skip') + '</span>' +
            '</div>'
          ).join('') : '') +
        (l.selected_next_step ? '<div class="next-badge"><svg width="12" height="12"><use href="#ic-arrow-right"/></svg> ' + esc(l.selected_next_step) + '</div>' : '') +
        (l.approver_id ? '<div style="margin-top:6px;font-size:.72rem;color:var(--text-2);font-family:var(--font-mono);">Approver: ' + esc(l.approver_id) + '</div>' : '') +
        (l.error_message ? '<div style="margin-top:6px;font-size:.72rem;color:var(--red);font-family:var(--font-mono);display:flex;align-items:center;gap:4px;"><svg width="12" height="12"><use href="#ic-cancel"/></svg> ' + esc(l.error_message) + '</div>' : '') +
        '<div class="log-json">' + esc(JSON.stringify(l, null, 2)) + '</div>' +
      '</div>';
    lv.appendChild(entry);
  });
}

function resetExecution() {
  currentExecId = null;
  document.getElementById('exec-progress-card').style.display = 'none';
  document.getElementById('exec-input-fields').innerHTML = '';
  document.getElementById('exec-start-btn').style.display = 'none';
  document.getElementById('exec-workflow-select').value = '';
  toast('Ready for new execution');
}

function quickExecute(id) {
  currentWorkflowId = id;
  navigate('executions');
  document.getElementById('exec-workflow-select').value = id;
  onExecWorkflowChange();
}

// ── AUDIT LOG ──
async function renderAuditLog() {
  const search = document.getElementById('audit-search')?.value || '';
  const status = document.getElementById('audit-filter')?.value || '';
  try {
    const [execRes, wfRes] = await Promise.all([
      API.get('/executions?search=' + encodeURIComponent(search) + '&status=' + status),
      API.get('/workflows?limit=200')
    ]);
    const wfMap = {}; (wfRes.data || []).forEach(w => wfMap[w.id||w._id] = w.name);
    const list = execRes.data || [];
    const tbody = document.getElementById('audit-table-body');
    const empty = document.getElementById('audit-empty');
    if (!list.length) { tbody.innerHTML = ''; empty.style.display = ''; return; }
    empty.style.display = 'none';
    tbody.innerHTML = '';
    list.forEach(e => {
      const id = e.id || e._id;
      const k = reg(id);
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="uuid-cell" title="' + esc(id) + '">' + eid(id) + '</td>' +
        '<td><div style="display:flex;align-items:center;gap:6px;"><div class="wf-icon" style="width:24px;height:24px;border-radius:5px;"><svg width="12" height="12"><use href="#ic-workflow"/></svg></div><span class="wf-name-cell" style="font-weight:700;">' + esc(wfMap[e.workflow_id] || '-') + '</span></div></td>' +
        '<td class="wf-version-cell" style="font-family:var(--font-mono);font-weight:700;">v' + e.workflow_version + '</td>' +
        '<td><span class="badge badge-' + e.status + '">' + e.status.replace('_', ' ').toUpperCase() + '</span></td>' +
        '<td class="wf-meta-cell" style="font-family:var(--font-mono);font-size:.76rem;font-weight:600;">' + esc(e.triggered_by || '-') + '</td>' +
        '<td class="wf-meta-cell" style="font-family:var(--font-mono);font-size:.76rem;font-weight:600;">' + fmtShort(e.started_at) + '</td>' +
        '<td class="wf-meta-cell" style="font-family:var(--font-mono);font-size:.76rem;font-weight:600;">' + fmtShort(e.ended_at) + '</td>' +
        '<td style="display:flex;gap:6px;align-items:center;">' +
          '<button class="btn btn-ghost btn-xs" data-action="view-logs" data-k="' + k + '"><svg width="11" height="11" style="vertical-align:middle;"><use href="#ic-log"/></svg> Logs</button>' +
          (e.status === 'failed' ? '<button class="btn btn-xs" data-action="audit-retry" data-k="' + k + '" style="background:var(--red-dim);color:var(--red);border:1px solid rgba(255,95,95,.25);"><svg width="11" height="11" style="vertical-align:middle;"><use href="#ic-retry"/></svg> Re-open</button>' : '') +
        '</td>';
      tbody.appendChild(tr);
    });
  } catch(e) { toast(e.message, 'error'); }
}

async function viewExecLogs(id) {
  try {
    const exec = await API.get('/executions/' + id);
    const wf = await API.get('/workflows/' + exec.workflow_id).catch(() => ({ name: '-' }));
    document.getElementById('exec-logs-modal-title').textContent = 'Logs — ' + wf.name;
    const body = document.getElementById('exec-logs-modal-body'); body.innerHTML = '';
    if (!exec.logs.length) { body.innerHTML = '<div class="text-muted">No logs.</div>'; openModal('modal-exec-logs'); return; }
    exec.logs.forEach((l, i) => {
      const lid = 'ml-' + i + '-' + Date.now();
      const logIconId = STEP_ICON_MAP[l.step_type] || 'ic-task';
      const entry = document.createElement('div'); entry.className = 'log-entry';
      entry.innerHTML =
        '<div class="log-header" data-lid="' + lid + '" onclick="toggleLog(this.dataset.lid)">' +
          '<div class="log-step-num">' + (i+1) + '</div>' +
          '<div style="display:flex;align-items:center;gap:6px;flex:1;"><svg width="13" height="13" style="color:var(--text-2);"><use href="#' + logIconId + '"/></svg><div class="log-step-title">' + esc(l.step_name) + '</div></div>' +
          '<span class="badge badge-' + l.status + '">' + l.status + '</span>' +
        '</div>' +
        '<div class="log-body" id="' + lid + '"><div class="log-json">' + esc(JSON.stringify(l, null, 2)) + '</div></div>';
      body.appendChild(entry);
    });

    // ── Retry panel inside modal for failed executions ──
    const footer = document.querySelector('#modal-exec-logs .modal-footer');
    const existingRetry = footer.querySelector('.modal-retry-panel');
    if (existingRetry) existingRetry.remove();

    if (exec.status === 'failed') {
      const failedLog = [...exec.logs].reverse().find(l => l.status === 'rejected' || l.status === 'failed');
      const isRejection = failedLog && failedLog.status === 'rejected';
      const failedStepName = failedLog ? failedLog.step_name : 'the failed step';
      const execId = exec.id || exec._id;

      const rPanel = document.createElement('div');
      rPanel.className = 'modal-retry-panel';
      rPanel.style.cssText = 'flex:1;display:flex;align-items:center;gap:12px;background:var(--red-dim);border:1px solid rgba(255,95,95,.22);border-radius:var(--radius-sm);padding:10px 14px;margin-right:8px;';
      rPanel.innerHTML =
        '<svg width="15" height="15" style="color:var(--red);flex-shrink:0;"><use href="#ic-warning"/></svg>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:.8rem;font-weight:700;color:var(--red);">' + (isRejection ? 'Accidentally rejected?' : 'Step failed') + '</div>' +
          '<div style="font-size:.7rem;color:var(--text-2);font-family:var(--font-mono);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">at <strong style="color:var(--text-1);">' + esc(failedStepName) + '</strong></div>' +
        '</div>' +
        '<button class="btn btn-primary btn-sm" data-action="modal-retry" data-exec-id="' + esc(execId) + '" style="flex-shrink:0;white-space:nowrap;">' +
          '<svg width="13" height="13"><use href="#ic-retry"/></svg> ' + (isRejection ? 'Re-open Approval' : 'Retry') +
        '</button>';
      footer.insertBefore(rPanel, footer.firstChild);
    }

    openModal('modal-exec-logs');
  } catch(e) { toast(e.message, 'error'); }
}

async function retryFromAudit(id) {
  try {
    closeModal('modal-exec-logs');
    toast('Re-opening execution...', 'success');
    const exec = await API.post('/executions/' + id + '/retry');
    const wf = await API.get('/workflows/' + exec.workflow_id);
    // Navigate to executions page and load this execution
    currentExecId = exec.id || exec._id;
    currentWorkflowId = exec.workflow_id;
    navigate('executions');
    document.getElementById('exec-progress-card').style.display = '';
    renderExecView(exec, wf);
    // Poll if it's waiting for approval
    if (exec.status === 'in_progress') {
      // Approval steps wait for manual action — the retry panel & approve buttons are now visible
    }
    toast('Execution re-opened — approve or reject below', 'success');
  } catch(e) { toast(e.message, 'error'); }
}


// ══════════════════════════════════════
// THEME TOGGLE
// ══════════════════════════════════════
let isDark = false;

function toggleTheme() {
  isDark = !isDark;
  const body = document.body;
  const thumb = document.getElementById('theme-thumb');
  const thumbIcon = document.getElementById('theme-thumb-icon');

  if (isDark) {
    body.classList.add('dark');
    if (thumbIcon) thumbIcon.textContent = '☾';
    if (thumb) thumb.style.background = '#24221B';
  } else {
    body.classList.remove('dark');
    if (thumbIcon) thumbIcon.textContent = '☀';
    if (thumb) thumb.style.background = '#F2D04E';
  }

  // Persist preference
  try { localStorage.setItem('fc-theme', isDark ? 'dark' : 'light'); } catch(e) {}

  // Re-render current page to apply dynamic JS-generated content
  const activePage = document.querySelector('.page.active');
  if (activePage) {
    const pageId = activePage.id.replace('page-', '');
    if (pageId === 'dashboard') renderDashboard();
    if (pageId === 'workflows') renderWorkflowList();
    if (pageId === 'audit') renderAuditLog();
  }
}

// Load saved preference
(function() {
  try {
    const saved = localStorage.getItem('fc-theme');
    if (saved === 'dark') { setTimeout(() => toggleTheme(), 50); }
  } catch(e) {}
})();

navigate('dashboard');
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(FRONTEND_HTML));

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('✅ MongoDB connected:', MONGO_URI);
    await seedSampleData();
    app.listen(PORT, () => {
      console.log('🚀 Raze running at http://localhost:' + PORT);
      console.log('   MongoDB URI:', MONGO_URI);
    });
  })
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });
