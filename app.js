const fs = require('fs');
const path = require('path');

// Config : .env (sinon .env.txt) à côté de app.js
const envFile = [path.join(__dirname, '.env'), path.join(__dirname, '.env.txt')].find(f => fs.existsSync(f));
require('dotenv').config({ path: envFile, quiet: true });

const puppeteer = require('puppeteer-extra');
puppeteer.use(require('puppeteer-extra-plugin-stealth')());
const cheerio = require('cheerio');
const mysql = require('mysql2/promise');
const schedule = require('node-schedule');

const sleep = ms => new Promise(res => setTimeout(res, ms));

const CONFIG = {
    chromePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    userDataDir: path.resolve(__dirname, process.env.CHROME_USERDIR || './puppeteer_profile'),
    headless: (process.env.HEADLESS || 'true') !== 'false',
    cron: process.env.CRON || '* * * * *',
    recrawlSeconds: Number(process.env.RECRAWL_HOURS || 6) * 3600,
};

// ─────────────────────────────────────────────
//  CONNEXION MYSQL (pool réutilisé entre les exécutions)
// ─────────────────────────────────────────────

const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    connectionLimit: 2,
});

// ─────────────────────────────────────────────
//  EXTRACTION DU PRIX
// ─────────────────────────────────────────────

// "1 753,99 €" / "1.753,99" / "1753.99" / "59€90" → nombre
function parsePrice(text) {
    let s = String(text || '').replace(/(\d)\s*€\s*(\d)/, '$1.$2');
    s = s.replace(/[^0-9.,-]+/g, '');
    const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
    if (lastComma > -1 && lastDot > -1) {
        // le dernier séparateur est la décimale, l'autre est le séparateur de milliers
        s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else {
        s = s.replace(',', '.');
    }
    s = s.replace(/^\.+|\.+$/g, '');
    return s === '' ? NaN : Number(s);
}

// ─────────────────────────────────────────────
//  UN CYCLE DE CRAWL
// ─────────────────────────────────────────────

async function crawlOne() {
    const minTimestamp = Math.floor(Date.now() / 1000) - CONFIG.recrawlSeconds;
    const [rows] = await db.query(
        'SELECT * FROM spy WHERE timestamp < ? ORDER BY timestamp ASC LIMIT 1', [minTimestamp]);

    if (!rows.length) {
        console.log('⚠ Aucun enregistrement à crawler.');
        return;
    }
    const row = rows[0];
    console.log('➡ URL :', row.url, `(id ${row.id})`);

    // Quoi qu'il arrive, on enregistre le résultat : sinon une URL en erreur
    // reste la plus ancienne et bloque toute la file indéfiniment.
    const markError = async (msg) => {
        await db.query('UPDATE spy SET timestamp=?, price=0, error=? WHERE id=?',
            [Math.floor(Date.now() / 1000), String(msg).slice(0, 250), row.id]);
        console.log('⚠', msg);
    };

    let domain;
    try {
        domain = new URL(row.url).hostname;
    } catch {
        return markError('URL invalide');
    }

    const [sel] = await db.query('SELECT * FROM spy_selector WHERE site=?', [domain]);
    if (!sel.length) return markError('No Selector (' + domain + ')');
    const { selector, subselector } = sel[0];

    let html;
    const browser = await puppeteer.launch({
        executablePath: CONFIG.chromePath,
        headless: CONFIG.headless,
        userDataDir: CONFIG.userDataDir,
        args: ['--window-size=1920,1080', '--no-sandbox'],
        defaultViewport: { width: 1920, height: 1080 },
    });
    try {
        const page = (await browser.pages())[0] || await browser.newPage();
        await page.goto(row.url, { timeout: 60000, waitUntil: 'networkidle2' });
        await sleep(3000);
        html = await page.content(); // page complète (head + body)
    } catch (e) {
        return markError('Page: ' + e.message);
    } finally {
        await browser.close().catch(() => {});
    }

    const $ = cheerio.load(html);
    const matches = $(selector);
    let price = NaN;
    if (matches.length === 1) {
        const el = matches.first();
        price = parsePrice(subselector === 'text' ? el.text() : el.attr(subselector));
    }
    console.log('📊 nbQuotes :', matches.length, '| prix détecté :', price);

    if (matches.length !== 1 || isNaN(price) || price <= 0) {
        return markError('No Price');
    }

    const now = Math.floor(Date.now() / 1000);
    await db.query("UPDATE spy SET timestamp=?, price=?, error='' WHERE id=?", [now, price, row.id]);
    await db.query('INSERT INTO history SET timestamp=?, price=?, artcode=?, site=?',
        [now, price, row.artcode, row.site]);
    console.log('💾 Prix mis à jour :', price);
}

// ─────────────────────────────────────────────
//  TÂCHE PLANIFIÉE (sans chevauchement)
// ─────────────────────────────────────────────

let running = false;

async function tick() {
    if (running) {
        console.log('⏳ Crawl précédent encore en cours, on saute cette minute.');
        return;
    }
    running = true;
    console.log('──────────────────────────────');
    console.log('🔎', new Date().toLocaleString('fr-FR'), '→ lancement du crawler');
    try {
        await crawlOne();
    } catch (e) {
        console.log('❌ Erreur :', e.message);
    } finally {
        running = false;
    }
}

if (process.argv.includes('--once')) {
    // Test manuel : node app.js --once
    tick().finally(() => db.end());
} else {
    schedule.scheduleJob(CONFIG.cron, tick);
    console.log('🟢 Crawler démarré (planning :', CONFIG.cron + ')');
}
