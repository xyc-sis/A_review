const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const key = 'kaoyan_review_v4';
function app(seed = {}) {
  const storage = new Map(Object.entries(seed));
  const root = { dataset: {}, innerHTML: '' };
  let exported;
  const context = vm.createContext({
    console, Date, Blob, setTimeout() {}, confirm: () => true,
    localStorage: {
      getItem: k => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: k => storage.delete(k),
    },
    URL: { createObjectURL: blob => { exported = blob; return 'blob:test'; }, revokeObjectURL() {} },
    document: {
      getElementById: id => id === 'app' ? root : null,
      addEventListener() {}, body: { appendChild() {} },
      createElement: () => ({ style: {}, click() {}, remove() {} }),
    },
    window: { addEventListener() {} },
  });
  const run = code => vm.runInContext(code, context);
  vm.runInContext(script, context);
  return { run, storage, root, json: code => JSON.parse(run(`JSON.stringify(${code})`)), exported: () => exported };
}
function fixture(a, id, offset, stage, mastered = false) {
  return a.json(`({id:${JSON.stringify(id)}, problemId:${JSON.stringify(id)}, subject:'高数',
    dateAdded:addDays(todayStr(),${offset}), notes:'原错因', errorType:'method',
    reviews:buildReviews(addDays(todayStr(),${offset})), history:[{id:'h1',date:todayStr(),result:'incorrect'}],
    ${stage ? `stage:${JSON.stringify(stage)},` : ''} mastered:${mastered}})`);
}
function seeded() {
  const a = app();
  const rows = [fixture(a, 'old-due', -5), fixture(a, 'old-tomorrow', -2), fixture(a, 'old-mastered', -9, undefined, true),
    fixture(a, 'new-due', -5, 'intensive'), fixture(a, 'new-tomorrow', -2, 'intensive'), fixture(a, 'new-mastered', -9, 'intensive', true)];
  return { rows, a: app({ [key]: JSON.stringify({ _v:3, problems:rows }) }) };
}

test('old records become foundation without changing schedules, history or stored bytes on load', () => {
  const { a, rows } = seeded();
  const migrated = a.json('state.problems');
  migrated.forEach((p, i) => { const { stage, ...rest } = p; const { stage: oldStage, ...old } = rows[i];
    assert.equal(stage, oldStage || 'foundation'); assert.deepEqual(rest, old); });
  assert.equal(a.json('state.stage'), 'intensive');
  assert.deepEqual(JSON.parse(a.storage.get(key)).problems, rows);
});

test('due, tomorrow, upcoming, active, mastered and header all respect selected stage', () => {
  const { a } = seeded();
  for (const [stage, prefix] of [['intensive','new'], ['foundation','old']]) {
    a.run(`switchStage('${stage}')`);
    assert.deepEqual(a.json('getDue().map(x=>x.problem.id)'), [`${prefix}-due`]);
    assert.deepEqual(a.json('getTomorrow().map(x=>x.problem.id)'), [`${prefix}-tomorrow`]);
    assert.deepEqual(a.json('getUpcoming().map(x=>x.problem.id)'), [`${prefix}-tomorrow`]);
    assert.equal(a.json('getActive().length'), 2);
    assert.deepEqual(a.json('getMastered().map(x=>x.id)'), [`${prefix}-mastered`]);
    assert.match(a.root.innerHTML, /class="stat-num">1<\/div>/);
  }
  a.run("switchStage('all')");
  assert.equal(a.json('getDue().length'), 2);
  assert.equal(a.json('getActive().length'), 4);
  assert.equal(a.json('getMastered().length'), 2);
  assert.match(a.root.innerHTML, /📚 基础阶段/);
  assert.match(a.root.innerHTML, /📚 强化阶段/);
});

test('new entries follow current stage; combined view defaults new entries to intensive', () => {
  const a = app();
  for (const stage of ['foundation', 'intensive', 'all']) {
    a.run(`switchStage('${stage}'); openAdd(); state.fProblem='新增${stage}'; submitForm()`);
    assert.equal(a.json('state.problems[0].stage'), stage === 'all' ? 'intensive' : stage);
  }
  const reloaded = app(Object.fromEntries(a.storage));
  assert.deepEqual(reloaded.json('state.problems'), a.json('state.problems'));
});

test('moving a question preserves its reviews and history; undo restores original stage', () => {
  const { a } = seeded();
  const original = a.json('state.problems[0]');
  a.run("openEdit(state.problems[0]); state.fStage='intensive'; submitForm()");
  const moved = a.json('state.problems[0]');
  assert.equal(moved.stage, 'intensive');
  assert.deepEqual(moved.reviews, original.reviews);
  assert.deepEqual(moved.history.slice(0,-1), original.history);
  assert.equal(moved.mastered, original.mastered);
  a.run('undoLast()');
  assert.deepEqual(a.json('state.problems[0]'), original);
});

test('reviewing intensive does not change foundation; calculation retry keeps stage', () => {
  const { a } = seeded();
  const old = a.json('state.problems.filter(p=>p.stage==="foundation")');
  a.run("{const p=state.problems.find(p=>p.id==='new-due');completeReview(p.id,p.reviews[0].id,'calculation')}");
  assert.deepEqual(a.json('state.problems.filter(p=>p.stage==="foundation")'), old);
  assert.deepEqual(a.json('getTomorrow().map(x=>x.problem.id).sort()'), ['new-due', 'new-tomorrow']);
  assert.equal(a.json('state.problems.find(p=>p.id==="new-due").stage'), 'intensive');
  a.run('undoLast()');
  a.run("{const p=state.problems.find(p=>p.id==='new-due');completeReview(p.id,p.reviews[0].id,true)}");
  assert.equal(a.json('state.problems.find(p=>p.id==="new-due").reviews[1].scheduledDate'), a.json('addDays(todayStr(),7)'));
});

test('search stays in selected collection, with combined search available', () => {
  const { a } = seeded();
  a.run("state.query='old-due'");
  const search = 'selectItems(getActive(),p=>p,p=>p.dateAdded)';
  assert.equal(a.json(search).length, 0);
  a.run("switchStage('all');state.query='old-due'");
  assert.deepEqual(a.json(search).map(p=>p.id), ['old-due']);
  a.run("switchStage('foundation')");
  assert.equal(a.json('state.query'), '');
});

test('export/import round trip includes both stages and complete review history', async () => {
  const { a } = seeded();
  a.run('exportData()');
  const backup = await a.exported().text();
  const b = app();
  b.run(`globalThis.backup=${JSON.stringify(backup)}`);
  await b.run("importDataFile({target:{files:[{text:async()=>backup}],value:'backup.json'}})");
  assert.deepEqual(b.json('state.problems'), a.json('state.problems'));
  assert.equal(JSON.parse(backup).version, 5);
});

test('old backups and old undo snapshots map to foundation and retain schedules', async () => {
  const { rows } = seeded();
  const old = rows.slice(0,3);
  const a = app();
  a.run(`globalThis.backup=${JSON.stringify(JSON.stringify({version:4,problems:old}))}`);
  await a.run("importDataFile({target:{files:[{text:async()=>backup}],value:'old.json'}})");
  assert.ok(a.json('state.problems').every(p=>p.stage==='foundation'));
  assert.deepEqual(a.json('state.problems[0].reviews'), old[0].reviews);
  a.storage.set(key+'_undo', JSON.stringify({problems:old}));
  a.run('undoLast()');
  assert.ok(a.json('state.problems').every(p=>p.stage==='foundation'));
});
