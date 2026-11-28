// Flusso 6: il percorso del cliente, dall'invito all'approvazione dello studio.
//
// L'area cliente (riepilogo «tocca a te», richieste per fase, canale protetto) ha le sue prove
// pezzo per pezzo; questa segue un cliente vero dall'inizio alla fine, perché i difetti stanno nei
// passaggi fra una pagina e l'altra e fra le due sessioni. In fila:
//   1. lo studio apre un incarico per un cliente nuovo e gli prepara una richiesta di dati;
//   2. lo avvisa («📣 Avvisa il cliente») e lo invita col Magic Link: il cliente entra dal link
//      che legge nell'email, non da un token passato sottobanco;
//   3. il cliente trova la richiesta in «Tocca a te», la compila con un allegato e una nota, e
//      manda il documento che lo studio aspetta (senza file la richiesta non parte);
//   4. cliente e studio si scrivono nel canale protetto, con un file per parte, e ciascuno
//      riscarica il file dell'altro identico a com'è partito;
//   5. quello che resta a riposo è cifrato: nel database e nell'archivio non c'è una riga in
//      chiaro, e nessuna email di avviso porta il contenuto;
//   6. un altro cliente dello stesso studio non legge la conversazione né scarica gli allegati;
//   7. lo studio controlla la risposta, la fa sua («Usa tutte le risposte del cliente») e chiude
//      il passaggio col ✓: il cliente la vede fra le «Chiuse» e non può più riscriverla.
//
// Cliente e incarico si creano via API, con le stesse chiamate del wizard (come il flusso 5):
// ogni corsa ha i suoi, quindi il test si rilancia senza `e2e:reset`. Le due sessioni stanno in
// due contesti del browser separati, come due persone su due computer.
//
// Le verifiche passano da strade diverse di proposito: l'interfaccia dice che cosa VEDE ciascuno,
// l'API che cosa è stato SCRITTO, il database e l'archivio come è conservato.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { AMBIENTE_E2E, leggiEmailDaMailpit, loginStaff, tutteLeEmailInMailpit } from './helpers';

const CAMPI = ['Ragione Sociale', 'Sede Operativa'] as const;
/** La richiesta di tipo «documento» che ogni attività porta dal modello (PassaggioModal). */
const RICHIESTA_DOCUMENTO = 'Verifica & Documentazione Incarico';

/** Scarica un file dal tasto dato e ne restituisce il contenuto. */
async function scarica(pagina: Page, azione: () => Promise<void>): Promise<string> {
  const [download] = await Promise.all([pagina.waitForEvent('download'), azione()]);
  return readFileSync(await download.path(), 'utf8');
}

/** La sessione di un cliente via API: un Magic Link nuovo, consumato subito. */
async function tokenCliente(request: APIRequestContext, headersStudio: Record<string, string>, clienteId: string, email: string): Promise<string> {
  const link = await request.post(`${AMBIENTE_E2E.apiBase}/clienti/${clienteId}/magic-link`, { headers: headersStudio, data: { email } });
  expect(link.ok(), await link.text()).toBeTruthy();
  const magicToken = new URL((await link.json()).magicUrl).searchParams.get('magic_token');
  const accesso = await request.post(`${AMBIENTE_E2E.apiBase}/auth/magic-login`, { data: { magicToken } });
  expect(accesso.ok(), await accesso.text()).toBeTruthy();
  return (await accesso.json()).token as string;
}

test('percorso del cliente: invito → richiesta compilata → messaggi cifrati con allegati → approvazione dello studio', async ({ page, request, browser }) => {
  const api = AMBIENTE_E2E.apiBase;
  const inizio = Date.now();
  // Una marca per corsa: i testi sono unici, quindi si ritrovano senza ambiguità in pagina, nel
  // database e nelle email anche dopo molte corse sullo stesso database.
  const marca = Math.random().toString(36).slice(2, 8);
  const token = await loginStaff(request, AMBIENTE_E2E.advisorEmail, AMBIENTE_E2E.password);
  const headers = { Authorization: `Bearer ${token}` };

  const nomeCliente = `Percorso Cliente ${marca} S.r.l.`;
  const emailCliente = `percorso-${marca}@cliente-di-prova.test`;
  const nomeProgetto = `Incarico percorso cliente ${marca}`;
  const titoloRichiesta = `Dati della società ${marca}`;
  const risposte: Record<(typeof CAMPI)[number], string> = {
    'Ragione Sociale': `Società di prova ${marca}`,
    'Sede Operativa': `Via delle Prove ${marca}, Milano`,
  };
  const notaCliente = `Nota riservata del cliente ${marca}`;
  const testoCliente = `Messaggio riservato del cliente ${marca}`;
  const testoStudio = `Risposta riservata dello studio ${marca}`;
  const file = (nome: string, contenuto: string) => ({ name: `${nome}-${marca}.txt`, mimeType: 'text/plain', buffer: Buffer.from(contenuto) });
  const fileRichiesta = file('visura', `Contenuto riservato della visura ${marca}`);
  const fileDocumento = file('documento', `Contenuto riservato del documento ${marca}`);
  const fileCliente = file('estratto', `Contenuto riservato dell'estratto ${marca}`);
  const fileStudio = file('parere', `Contenuto riservato del parere ${marca}`);
  /** Ciò che non deve comparire in chiaro fuori dalla conversazione: database, archivio, email. */
  const riservati = [notaCliente, testoCliente, testoStudio, ...[fileRichiesta, fileDocumento, fileCliente, fileStudio].map((f) => f.buffer.toString())];

  // ── 1. Lo studio: cliente e incarico nuovi, e una richiesta di dati per il cliente ──────────
  const creaCliente = await request.post(`${api}/clienti`, { headers, data: { nome: nomeCliente, tipo: 'company', email: emailCliente } });
  expect(creaCliente.ok(), await creaCliente.text()).toBeTruthy();
  const cliente: { id: string } = await creaCliente.json();

  const moduli: Array<{ id: string; versione: number }> = await (await request.get(`${api}/moduli`, { headers })).json();
  const analisi = moduli.find((m) => m.id === 'mod-m01');
  expect(analisi, 'il modulo mod-m01 deve essere in libreria (seed)').toBeTruthy();
  const progetto = await (await request.post(`${api}/progetti`, { headers, data: { clienteId: cliente.id, nome: nomeProgetto } })).json();
  const preventivo = await (await request.post(`${api}/preventivi`, {
    headers,
    data: { clienteId: cliente.id, progettoId: progetto.id, righe: [{ moduloTemplateId: analisi!.id, moduloTemplateVersione: analisi!.versione }] },
  })).json();
  const accettazione = await request.post(`${api}/preventivi/${preventivo.id}/accetta`, { headers });
  expect(accettazione.ok(), await accettazione.text()).toBeTruthy();
  const dettaglio = await (await request.get(`${api}/progetti/${progetto.id}`, { headers })).json();
  const voce: { id: string; nome: string } = dettaglio.moduli[0].microvoci[0];
  expect(voce?.nome, 'il modulo di prova deve avere attività').toBeTruthy();

  /** I passaggi a carico del cliente dell'attività, come sono a database. */
  const passaggiDelCliente = async (): Promise<Array<{ id: string; titolo: string; stato: string; risposteFormJson: unknown; risposteClienteJson: unknown; rispostaClienteAt: string | null }>> => {
    const letto = await (await request.get(`${api}/progetti/${progetto.id}`, { headers })).json();
    return letto.moduli[0].microvoci.find((m: { id: string }) => m.id === voce.id).passaggi.filter((p: { chi: string }) => p.chi === 'cliente');
  };

  await page.goto('/login');
  await page.getByPlaceholder('nome.cognome@studio.it').fill(AMBIENTE_E2E.advisorEmail);
  await page.locator('input[type="password"]').fill(AMBIENTE_E2E.password);
  await page.getByRole('button', { name: '🔒 Accedi alla Piattaforma' }).click();
  await expect(page).not.toHaveURL(/\/login/);

  // La richiesta nasce dalla scheda dell'attività: «➕ Aggiungi Azione», un form a carico del cliente.
  await page.goto(`/projects/${progetto.id}`);
  await page.getByText(voce.nome, { exact: true }).first().click();
  const modale = page.locator('#proc-ov');
  await modale.getByRole('button', { name: '➕ Aggiungi Azione' }).click();
  await page.getByLabel('Titolo del Passaggio / Azione *').fill(titoloRichiesta);
  await page.getByLabel('Tipo di Passaggio').selectOption('form');
  await page.getByLabel('Assegnato a').selectOption('cliente');
  await page.getByLabel('Dati da chiedere al cliente').fill(CAMPI.join(', '));
  await page.getByRole('button', { name: '+ Salva Passaggio' }).click();
  await expect(modale.getByText(titoloRichiesta, { exact: true })).toBeVisible();
  // È scritta, non solo disegnata: il cliente la riceve dal database.
  await expect.poll(async () => (await passaggiDelCliente()).map((p) => p.titolo)).toContain(titoloRichiesta);
  const richiesta = (await passaggiDelCliente()).find((p) => p.titolo === titoloRichiesta)!;
  await modale.getByRole('button', { name: 'Chiudi la finestra' }).click();
  await expect(modale).toHaveCount(0);

  // ── 2. Lo studio avvisa il cliente e lo invita ─────────────────────────────────────────────
  await page.reload();
  await page.getByRole('button', { name: '📣 Avvisa il cliente' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Cliente avvisato' })).toBeVisible();
  // L'avviso dice che c'è qualcosa da fare, non che cosa.
  const avvisoRichiesta = await leggiEmailDaMailpit(request, { destinatario: emailCliente, oggetto: 'Lo studio ti chiede' });
  expect(avvisoRichiesta.html).toContain(nomeProgetto);
  expect(avvisoRichiesta.html).not.toContain(titoloRichiesta);

  // `?client=<nome>` apre il modale del Magic Link, come dalla scheda del progetto.
  await page.goto(`/clients?client=${encodeURIComponent(nomeCliente)}`);
  await page.getByPlaceholder('cliente@esempio.it').fill(emailCliente);
  await page.getByRole('button', { name: 'Genera e invia' }).click();
  await expect(page.getByText('Link di accesso cliente generato e inviato per email')).toBeVisible();
  const invito = await leggiEmailDaMailpit(request, { destinatario: emailCliente, oggetto: 'Accesso al Portale Cliente' });
  const magicUrl = invito.html.match(/href="([^"]*\/portal\?magic_token=[^"]+)"/)?.[1]?.replace(/&amp;/g, '&');
  expect(magicUrl, "l'email di invito deve portare il link di accesso").toBeTruthy();

  // ── 3. Il cliente entra dal link dell'email e risponde alle richieste ──────────────────────
  const contestoCliente = await browser.newContext({ locale: 'it-IT', baseURL: 'http://localhost:5173' });
  const portale = await contestoCliente.newPage();
  await portale.goto(magicUrl!);
  await expect(portale.getByRole('tab', { name: /Riepilogo/ })).toBeVisible();
  // «Tocca a te» porta la richiesta dello studio, col tasto che apre la scheda giusta.
  await portale.getByRole('listitem').filter({ hasText: titoloRichiesta }).getByRole('button', { name: 'Rispondi →' }).click();

  const scheda = portale.getByRole('article', { name: titoloRichiesta });
  await expect(scheda).toBeVisible();
  for (const campo of CAMPI) await scheda.getByLabel(campo, { exact: true }).fill(risposte[campo]);
  await scheda.getByLabel(`Allega file a ${titoloRichiesta}`).setInputFiles(fileRichiesta);
  await scheda.getByLabel('Nota per lo studio (facoltativa)').fill(notaCliente);
  await scheda.getByRole('button', { name: 'Invia allo studio' }).click();
  await expect(scheda.getByText(/Inviata.*la sta controllando lo studio/)).toBeVisible();

  // Le risposte stanno nelle colonne del cliente, non in quelle dello studio, e il passaggio resta
  // aperto: rispondere non è chiudere.
  const dopoRisposta = (await passaggiDelCliente()).find((p) => p.id === richiesta.id)!;
  expect(dopoRisposta.risposteClienteJson).toEqual(risposte);
  expect(dopoRisposta.risposteFormJson).toBeNull();
  expect(dopoRisposta.rispostaClienteAt).toBeTruthy();
  expect(dopoRisposta.stato).not.toBe('done');

  // Il documento che lo studio aspetta: senza file la richiesta non parte, e lo dice.
  const schedaDocumento = portale.getByRole('article', { name: RICHIESTA_DOCUMENTO });
  await schedaDocumento.getByRole('button', { name: 'Invia allo studio' }).click();
  await expect(schedaDocumento.getByRole('alert')).toContainText('aspetta un documento');
  await schedaDocumento.getByLabel(`Allega file a ${RICHIESTA_DOCUMENTO}`).setInputFiles(fileDocumento);
  await schedaDocumento.getByRole('button', { name: 'Invia allo studio' }).click();
  await expect(schedaDocumento.getByText(/Inviata.*la sta controllando lo studio/)).toBeVisible();

  // ── 4. Il canale protetto: il cliente scrive, con un allegato ──────────────────────────────
  await portale.getByRole('tab', { name: /Messaggi/ }).click();
  await expect(portale.getByText('🔒 Canale protetto.')).toBeVisible();
  // Le risposte alle richieste sono già nella conversazione, con i loro file.
  await expect(portale.getByText(notaCliente)).toBeVisible();
  await portale.getByLabel('Scrivi allo studio').fill(testoCliente);
  await portale.getByLabel('Allega file', { exact: true }).setInputFiles(fileCliente);
  await portale.getByRole('button', { name: 'Invia', exact: true }).click();
  // Il campo si svuota solo a messaggio salvato.
  await expect(portale.getByLabel('Scrivi allo studio')).toHaveValue('');
  const bollaCliente = portale.getByText(testoCliente, { exact: true }).locator('xpath=..');
  await expect(bollaCliente.getByTitle('Questo messaggio è conservato cifrato.')).toBeVisible();
  expect(await scarica(portale, () => bollaCliente.getByRole('button', { name: '⬇️ Scarica' }).click())).toBe(fileCliente.buffer.toString());

  // ── 5. Lo studio legge, scarica gli allegati e risponde con un file suo ────────────────────
  await page.goto(`/projects/${progetto.id}`);
  await page.getByRole('button', { name: '💬 Comunicazioni & Ingestion' }).click();
  const bollaDi = (testo: string) => page.getByText(testo, { exact: false }).locator('xpath=ancestor::div[.//input[@type="checkbox"]][1]');
  await expect(bollaDi(testoCliente).getByText('🔒 cifrato')).toBeVisible();
  expect(await scarica(page, () => bollaDi(testoCliente).getByRole('button', { name: '⬇️ Scarica' }).click())).toBe(fileCliente.buffer.toString());
  expect(await scarica(page, () => bollaDi(notaCliente).getByRole('button', { name: '⬇️ Scarica' }).click())).toBe(fileRichiesta.buffer.toString());
  expect(await scarica(page, () => bollaDi(`Risposta alla richiesta «${RICHIESTA_DOCUMENTO}»`).getByRole('button', { name: '⬇️ Scarica' }).click())).toBe(fileDocumento.buffer.toString());

  const compositore = page.locator('form').filter({ hasText: 'Rispondi al Cliente dal Progetto' });
  await compositore.locator('select').first().selectOption('portal');
  await compositore.locator('textarea').fill(testoStudio);
  await compositore.locator('input[type="file"]').setInputFiles(fileStudio);
  await expect(compositore.getByText(`📎 ${fileStudio.name}`)).toBeVisible();
  await compositore.getByRole('button', { name: 'Invia Ora →' }).click();
  await expect(bollaDi(testoStudio)).toBeVisible();

  // Il cliente viene avvisato che c'è un messaggio, non di cosa dice.
  const avvisoMessaggio = await leggiEmailDaMailpit(request, { destinatario: emailCliente, oggetto: 'Nuovo messaggio dallo studio' });
  expect(avvisoMessaggio.html).not.toContain(testoStudio);

  // ── 6. Il cliente legge la risposta e scarica il file dello studio ─────────────────────────
  await portale.reload();
  // «Tocca a te» lo annuncia, e porta alla scheda Messaggi.
  const daLeggere = portale.getByRole('listitem').filter({ hasText: 'Un messaggio dello studio da leggere' });
  await daLeggere.getByRole('button').click();
  const bollaRisposta = portale.getByText(testoStudio, { exact: true }).locator('xpath=..');
  await expect(bollaRisposta).toBeVisible();
  expect(await scarica(portale, () => bollaRisposta.getByRole('button', { name: '⬇️ Scarica' }).click())).toBe(fileStudio.buffer.toString());
  // Letto il messaggio, non è più una cosa da fare: tornando al riepilogo l'avviso non c'è più.
  await portale.getByRole('tab', { name: /Riepilogo/ }).click();
  await expect(portale.getByText('Tocca a te:').first()).toBeVisible();
  await expect(daLeggere).toHaveCount(0);

  // ── 7. A riposo è cifrato: database, archivio, email ───────────────────────────────────────
  const comunicazioni = await (await request.get(`${api}/progetti/${progetto.id}/comunicazioni`, { headers })).json();
  const messaggi: Array<{ id: string; testo: string; cifrato?: boolean; allegatiJson?: string | null }> = Array.isArray(comunicazioni) ? comunicazioni : comunicazioni.comunicazioni ?? [];
  // Quattro messaggi: le due risposte alle richieste, il messaggio del cliente, quello dello studio.
  expect(messaggi).toHaveLength(4);
  for (const m of messaggi) expect(m.cifrato, `«${m.testo.slice(0, 40)}» deve risultare cifrato`).toBe(true);

  const db = new PrismaClient({ datasourceUrl: AMBIENTE_E2E.databaseUrl });
  try {
    const righe = await db.$queryRaw<Array<{ testo: string; allegati_json: string | null }>>`
      select testo, allegati_json from comunicazione_progetto where progetto_id = ${progetto.id}`;
    expect(righe).toHaveLength(4);
    for (const riga of righe) {
      expect(riga.testo).toMatch(/^bmc1\./);
      expect(riga.allegati_json).toMatch(/^bmc1\./);
      for (const segreto of riservati) expect(`${riga.testo}${riga.allegati_json}`).not.toContain(segreto);
    }
    // Nemmeno la campanella porta il contenuto: è una tabella che nessuno protegge come la corrispondenza.
    const notifiche = await db.$queryRaw<Array<{ tutto: string }>>`
      select row_to_json(n)::text as tutto from notifica n where n.created_at >= ${new Date(inizio)}`;
    expect(notifiche.length).toBeGreaterThan(0);
    for (const notifica of notifiche) for (const segreto of riservati) expect(notifica.tutto).not.toContain(segreto);
  } finally {
    await db.$disconnect();
  }

  // I quattro file di questa corsa stanno in archivio cifrati: nessun file scritto da quando il
  // test è partito porta in chiaro il contenuto di uno degli allegati.
  const archivio = path.join(process.cwd(), 'uploads');
  const scritti = readdirSync(archivio).filter((nome) => statSync(path.join(archivio, nome)).mtimeMs >= inizio - 1000);
  const protetti = scritti.filter((nome) => nome.endsWith('_protetto.bin'));
  expect(protetti.length).toBeGreaterThanOrEqual(4);
  for (const nome of scritti) {
    const contenuto = readFileSync(path.join(archivio, nome));
    if (nome.endsWith('_protetto.bin')) expect(contenuto.subarray(0, 4).toString('ascii')).toBe('BMC1');
    for (const segreto of riservati) expect(contenuto.includes(segreto), `${nome} porta in chiaro un contenuto riservato`).toBe(false);
  }

  for (const email of await tutteLeEmailInMailpit(request)) {
    for (const segreto of riservati) expect(`${email.oggetto}${email.html}${email.testo}`, `l'email «${email.oggetto}» porta un contenuto riservato`).not.toContain(segreto);
  }

  // ── 8. Un altro cliente dello stesso studio resta fuori ────────────────────────────────────
  const tokenEstraneo = await tokenCliente(request, headers, AMBIENTE_E2E.clienteBelfort.id, AMBIENTE_E2E.clienteBelfort.email);
  const headersEstraneo = { Authorization: `Bearer ${tokenEstraneo}` };
  const letturaEstranea = await request.get(`${api}/progetti/${progetto.id}/comunicazioni`, { headers: headersEstraneo });
  expect(letturaEstranea.ok(), 'un altro cliente non deve leggere la conversazione').toBeFalsy();
  const conAllegato = messaggi.find((m) => m.testo === testoStudio)!;
  const allegatoEstraneo = await request.get(`${api}/progetti/${progetto.id}/comunicazioni/${conAllegato.id}/allegati/0`, { headers: headersEstraneo });
  expect(allegatoEstraneo.status()).toBe(404);
  // E senza accesso non si scarica affatto: non esiste un indirizzo da girare a un terzo.
  expect((await request.get(`${api}/progetti/${progetto.id}/comunicazioni/${conAllegato.id}/allegati/0`)).status()).toBe(401);

  // ── 9. Lo studio controlla la risposta, la fa sua e chiude il passaggio ────────────────────
  await page.getByRole('button', { name: '🗂 Moduli & Microvoci' }).click();
  // Sopra i moduli: quanto è in mano al cliente, e quanto ha già la sua risposta.
  await expect(page.getByText('2 hanno già la sua risposta')).toBeVisible();
  await page.getByText(voce.nome, { exact: true }).first().click();
  const cartaRichiesta = modale.getByText(titoloRichiesta, { exact: true }).locator('xpath=ancestor::div[.//button[contains(., "Compila / Visualizza Form")]][1]');
  await expect(cartaRichiesta.getByText(/Il cliente ha risposto il .*: da controllare/)).toBeVisible();
  await cartaRichiesta.getByRole('button', { name: '📋 Compila / Visualizza Form' }).click();
  // Le risposte del cliente sono una proposta finché l'operatore non le usa e salva.
  for (const campo of CAMPI) await expect(page.getByText(risposte[campo], { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Usa tutte le risposte del cliente' }).click();
  for (const campo of CAMPI) await expect(page.getByLabel(`📝 ${campo}`)).toHaveValue(risposte[campo]);
  await page.getByRole('button', { name: '✓ Salva i dati' }).click();
  await expect.poll(async () => (await passaggiDelCliente()).find((p) => p.id === richiesta.id)!.risposteFormJson).toEqual(risposte);

  await cartaRichiesta.getByTitle('Segna come completato / da fare').click();
  await expect.poll(async () => (await passaggiDelCliente()).find((p) => p.id === richiesta.id)!.stato).toBe('done');
  // Chiudere non cancella ciò che il cliente ha scritto, né ciò che lo studio ha registrato.
  const chiuso = (await passaggiDelCliente()).find((p) => p.id === richiesta.id)!;
  expect(chiuso.risposteFormJson).toEqual(risposte);
  expect(chiuso.risposteClienteJson).toEqual(risposte);

  // ── 10. Il cliente vede la richiesta chiusa, e non la può riscrivere ───────────────────────
  await portale.reload();
  await portale.getByRole('tab', { name: /Da fare/ }).click();
  await expect(portale.getByRole('article', { name: titoloRichiesta }).getByText('✓ Chiusa dallo studio')).toBeVisible();
  // L'altra, che lo studio non ha ancora chiuso, resta «in controllo».
  await expect(portale.getByRole('article', { name: RICHIESTA_DOCUMENTO }).getByText(/Inviata.*la sta controllando lo studio/)).toBeVisible();

  const tokenDelCliente = await tokenCliente(request, headers, cliente.id, emailCliente);
  const riscrittura = await request.post(`${api}/portal/richieste/${richiesta.id}/risposta`, {
    headers: { Authorization: `Bearer ${tokenDelCliente}` },
    data: { risposte: { 'Ragione Sociale': 'Altra', 'Sede Operativa': 'Altra' } },
  });
  expect(riscrittura.status()).toBe(409);

  await contestoCliente.close();
});
