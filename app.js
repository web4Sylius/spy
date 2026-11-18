const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const cheerio = require('cheerio');
const sleep = ms => new Promise(res => setTimeout(res, ms));
const mysql = require('mysql');
const schedule = require('node-schedule');

// ─────────────────────────────────────────────
//  CONNEXION MYSQL
// ─────────────────────────────────────────────

function getDb() {
    return mysql.createConnection({
        host: "test.ma-cave-a-vin.fr",
        user: "spybenoit",
        password: "********",
        database: "spy"
    });
}

// ─────────────────────────────────────────────
//  TÂCHE PLANIFIÉE
// ─────────────────────────────────────────────

schedule.scheduleJob('* * * * *', async () => {

    console.log("──────────────────────────────");
    console.log("🔎 Nouvelle minute → lancement du crawler");

    const db = getDb();

    // Connexion MySQL
    try {
        db.connect();
        console.log("✅ MySQL connecté.");
    } catch (e) {
        console.log("❌ Erreur MySQL → impossible de se connecter");
        return;
    }

    // Trouver une URL à crawler
    const mintimestamp = Math.floor(Date.now() / 1000) - 6 * 3600;
    let urltocrawl = "", idspy = 0, artcode = "", site = "";

    try {
        const query = "SELECT * FROM spy WHERE timestamp < " + mintimestamp + " ORDER BY timestamp ASC LIMIT 1";

        console.log("📝 SQL :", query);

        await new Promise((resolve, reject) => {
            db.query(query, (err, result) => {
                if (err) return reject(err);

                if (!result.length) {
                    console.log("⚠ Aucun enregistrement à crawler.");
                    resolve();
                    return;
                }

                const row = result[0];
                idspy = row.id;
                urltocrawl = row.url;
                artcode = row.artcode;
                site = row.site;

                console.log("➡ URL trouvée :", urltocrawl);

                resolve();
            });
        });

    } catch (e) {
        console.log("❌ Erreur SQL SELECT :", e);
        db.end();
        return;
    }

    if (!urltocrawl) {
        db.end();
        return;
    }

    // ─────────────────────────────────────────────
    //  SELECTOR DU SITE
    // ─────────────────────────────────────────────

    let selector = "", subselector = "", section = "body";
    let domainname = new URL(urltocrawl).hostname;

    try {
        await new Promise((resolve, reject) => {
            db.query("SELECT * FROM spy_selector WHERE site='" + domainname + "'", (err, result) => {
                if (err) return reject(err);

                if (!result.length) {
                    console.log("❌ Aucun sélecteur trouvé pour :", domainname);
                    resolve();
                    return;
                }

                selector = result[0].selector;
                subselector = result[0].subselector;
                section = result[0].section;

                console.log("✔ pattern:", selector, ", subpattern:", subselector);

                resolve();
            });
        });

    } catch (e) {
        console.log("❌ Erreur SQL selector :", e);
        db.end();
        return;
    }

    if (!selector) {
        console.log("⚠ Impossible de crawler → pas de pattern");
        db.end();
        return;
    }

    // ─────────────────────────────────────────────
    //  LANCEMENT PUPPETEER STABLE
    // ─────────────────────────────────────────────

    let browser;

    try {
        browser = await puppeteer.launch({
            executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            headless: false,
            userDataDir: 'C:\\Users\\spy\\puppeteer_profile', // profil dédié
            args: ['--window-size=1920,1080'],
            defaultViewport: { width: 1920, height: 1080 }
        });
    } catch (e) {
        console.log("❌ Chrome ne démarre pas :", e);
        db.end();
        return;
    }

    console.log("🚀 Chrome lancé (profil dédié OK).");

    const page = (await browser.pages())[0];

    try {
        await page.goto(urltocrawl, {
            timeout: 60000,
            waitUntil: "networkidle2"
        });
    } catch (e) {
        console.log("❌ Impossible d'ouvrir la page :", e.message);
        await browser.close();
        db.end();
        return;
    }

    await sleep(3000);

    // Récupérer le HTML
    let bodyHTML = await page.evaluate(() => document.body.innerHTML);
    let $ = cheerio.load(bodyHTML);

    let quotes = $(selector);
    let nbquotes = 0;
    let number = 0;

    quotes.each((i, el) => {
        nbquotes++;
        let raw = (subselector === "text")
            ? $(el).text()
            : $(el).attr(subselector) || "";

        raw = raw.replace(",", ".").replace("€", ".");
        raw = raw.replace(/[^0-9.-]+/g, "").trim();

        if (raw.endsWith(".")) raw = raw.slice(0, -1);
        if (raw.startsWith(".")) raw = raw.slice(1);

        number = Number(raw);
    });

    console.log("📊 nbQuotes :", nbquotes, "prix détecté :", number);

    // ─────────────────────────────────────────────
    //  MISE À JOUR SQL
    // ─────────────────────────────────────────────

    const now = Math.floor(Date.now() / 1000);

    if (nbquotes === 1 && !isNaN(number)) {
        db.query(
            "UPDATE spy SET timestamp=?, price=?, error='' WHERE id=?",
            [now, number, idspy]
        );

        db.query(
            "INSERT INTO history SET timestamp=?, price=?, artcode=?, site=?",
            [now, number, artcode, site]
        );

        console.log("💾 Prix mis à jour :", number);
    } else {
        db.query(
            "UPDATE spy SET timestamp=?, price=0, error='No Price' WHERE id=?",
            [now, idspy]
        );
        console.log("⚠ Aucun prix trouvé ou trop de résultats.");
    }

    // ─────────────────────────────────────────────
    //  FERMETURES PROPRES
    // ─────────────────────────────────────────────

    await browser.close(); // important: await !
    db.end();

    console.log("🟢 Fini proprement.");

});
