'use strict';

// CLI-команда физического удаления истории анализа (единственный путь, которым
// снимки удаляются насовсем). Рабочие операции портала историю не удаляют.
//
//   npm run purge -- --list                       список тендеров с архивом
//   npm run purge -- --tender <id>                ПЛАН (dry-run, ничего не удаляет)
//   npm run purge -- --tender <id> --confirm <id> удалить (id должен совпасть)
//   … --keep-last 3        сохранить 3 последних архивных прогона на стадию/scope
//   … --older-than 2026-01-01T00:00:00Z   удалять только начатые раньше даты
//
// Активный (по указателю) и выполняющийся прогон не удаляются никогда.

require('dotenv').config({ path: require('node:path').join(__dirname, '..', '..', '.env') });

const db = require('../db/connection');
const purge = require('../services/admin/purgeService');

function parseArgs(argv) {
  const out = { keepLast: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[i + 1];
    if (a === '--list') out.list = true;
    else if (a === '--tender') { out.tender = next(); i += 1; }
    else if (a === '--confirm') { out.confirm = next(); i += 1; }
    else if (a === '--keep-last') { out.keepLast = Number(next()) || 0; i += 1; }
    else if (a === '--older-than') { out.olderThan = next(); i += 1; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list || !args.tender) {
    const rows = await purge.purgeCandidates();
    if (!rows.length) {
      console.log('Архивных прогонов нет — удалять нечего.');
    } else {
      console.log('Тендеры с архивными прогонами:');
      for (const r of rows) console.log(`  ${r.tender_id}\t${r.archived} архивных`);
    }
    if (!args.tender) {
      console.log('\nПлан по тендеру:  npm run purge -- --tender <id>');
      console.log('Удалить:          npm run purge -- --tender <id> --confirm <id>');
    }
    if (!args.tender) return;
  }

  const opts = { keepLast: args.keepLast, olderThan: args.olderThan || null, confirm: args.confirm || null };
  const res = await purge.purgeTenderHistory(args.tender, opts);

  console.log(`\nТендер ${res.tender_id}: прогонов всего ${res.runs_total}, сохраняется ${res.runs_kept}, `
    + `под удаление ${res.runs_to_purge.length} (keep-last ${res.keep_last}).`);
  for (const r of res.runs_to_purge) {
    console.log(`  - ${r.id} kind=${r.kind}${r.stage ? ` stage=${r.stage}` : ''} status=${r.status} started=${r.started_at}`);
  }
  const rows = Object.entries(res.rows || {}).filter(([, v]) => v > 0);
  if (rows.length) console.log(`  строк: ${rows.map(([k, v]) => `${k}=${v}`).join(', ')}`);

  if (res.deleted) {
    console.log(`\nУДАЛЕНО: ${res.runs_deleted} прогонов и связанные строки. Событие записано в журнал аудита.`);
  } else {
    console.log(`\nDRY-RUN (${res.reason}). Ничего не удалено.`);
    if (res.runs_to_purge.length) {
      console.log(`Для удаления повторите с подтверждением: npm run purge -- --tender ${res.tender_id} --confirm ${res.tender_id}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(`purge: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (db.isPoolOpen && db.isPoolOpen()) await db.close();
  });
