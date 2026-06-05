module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query, visitorId } = req.body;
  if (!query) return res.status(400).json({ error: 'No query' });

  // Patient-specific medical advice — decline immediately
  if (isMedicalAdvice(query)) {
    await logAndNotify({ query, type: 'C', visitorId });
    return res.status(200).json({ type: 'C', declined: true, synthesis: '', pubmed: [], semantic: [], trials: [], exa: [] });
  }

  // Classify query → decide which sources to hit
  const sources = classifyQuery(query);

  // Fetch all relevant sources in parallel
  const [pubmedRes, semanticRes, trialsRes, europePmcRes, exaRes] = await Promise.allSettled([
    sources.includes('pubmed')   ? searchPubMed(query)          : Promise.resolve([]),
    sources.includes('semantic') ? searchSemanticScholar(query)  : Promise.resolve([]),
    sources.includes('trials')   ? searchClinicalTrials(query)   : Promise.resolve([]),
    sources.includes('europepmc')? searchEuropePMC(query)        : Promise.resolve([]),
    sources.includes('exa')      ? searchExa(query)              : Promise.resolve([]),
  ]);

  const results = {
    pubmed:    pubmedRes.status    === 'fulfilled' ? pubmedRes.value    : [],
    semantic:  semanticRes.status  === 'fulfilled' ? semanticRes.value  : [],
    trials:    trialsRes.status    === 'fulfilled' ? trialsRes.value    : [],
    europepmc: europePmcRes.status === 'fulfilled' ? europePmcRes.value : [],
    exa:       exaRes.status       === 'fulfilled' ? exaRes.value       : [],
  };

  const totalSources = Object.values(results).reduce((n, arr) => n + arr.length, 0);
  const type = (results.pubmed.length + results.semantic.length + results.europepmc.length) > 0 ? 'A' : 'B';

  // Gemini synthesis
  const synthesis = synthesize(query, results, totalSources);

  await logAndNotify({ query, type, visitorId, synthesis: synthesis.slice(0, 300) });

  return res.status(200).json({ type, declined: false, synthesis, ...results });
};

// ── Query classification ───────────────────────────────────────────────────

function classifyQuery(q) {
  const l = q.toLowerCase();
  const s = new Set(['pubmed', 'exa']); // always run these two

  if (/psilocybin|ketamine|mdma|psychedelic|clinical|trial|study|evidence|efficacy|outcome|anxiety|depression|cancer|palliative|hospice|dosing|mechanism|pharmacology/.test(l)) {
    s.add('semantic'); s.add('europepmc');
  }
  if (/ongoing|active|pipeline|registered|nct|upcoming|recruiting|phase [123]/.test(l)) {
    s.add('trials');
  }

  return [...s];
}

function isMedicalAdvice(q) {
  const l = q.toLowerCase();
  return /my patient|my mother|my father|my wife|my husband|my friend|should i take|how much should|what dose|is it safe for|can i give|recommend for my|mg for a specific|dose for (a |my )/.test(l);
}

// ── PubMed ─────────────────────────────────────────────────────────────────

// Verified PMIDs for the two core Heffter/RiverStyx-funded psilocybin EOL trials
// Both published J Psychopharmacol Vol 30 Issue 12, Nov 30 2016 — consecutive PMIDs confirmed
const KEY_STUDIES = {
  psilocybin_eol: ['27909165', '27909164'], // Griffiths 2016 (Hopkins), Ross 2016 (NYU)
  ketamine_eol:   [],                        // Wolfson PMID unverified — rely on Semantic Scholar + Exa
  eolpc:          ['27909165', '27909164'],
};

function extractMedicalTerms(query) {
  const q = query.toLowerCase();
  // Build a clean PubMed boolean query from the prose question
  const terms = [];

  if (/psilocybin|magic mushroom|psilo/.test(q))      terms.push('psilocybin');
  if (/ketamine|kap/.test(q))                          terms.push('ketamine');
  if (/mdma/.test(q))                                  terms.push('MDMA');
  if (/anxiety|distress/.test(q))                      terms.push('anxiety');
  if (/depression|depressive/.test(q))                 terms.push('depression');
  if (/cancer|oncol|tumor/.test(q))                    terms.push('neoplasms');
  if (/hospice|palliative|end.of.life|eol|dying/.test(q)) terms.push('"palliative care"[MeSH]');
  if (/trial|study|rct|randomized/.test(q))            terms.push('clinical trial[pt]');
  if (/lsd|lysergic/.test(q))                          terms.push('LSD');
  if (/psychedelic|hallucinogen/.test(q))              terms.push('hallucinogens[MeSH]');
  if (/spiritual|existential|meaning/.test(q))         terms.push('spirituality');
  if (/oregon|colorado|state law|legal/.test(q))       terms.push('legislation[MeSH]');

  // Default if nothing specific detected
  if (terms.length === 0) terms.push('psilocybin', '"palliative care"[MeSH]');

  return terms.join(' AND ');
}

function detectKeyStudies(query) {
  const q = query.toLowerCase();
  const ids = new Set();

  // Detect references to specific studies or institutions
  if (/hopkins|griffith|johns hopkins/.test(q))       KEY_STUDIES.psilocybin_eol.forEach(id => ids.add(id));
  if (/nyu|ross|bossis/.test(q))                      ['27685429','31903927'].forEach(id => ids.add(id));
  if (/wolfson|ketamine research foundation|krc/.test(q)) KEY_STUDIES.ketamine_eol.forEach(id => ids.add(id));
  if (/agin-liebes|long.term follow.up/.test(q))      ids.add('32876501');
  if (/heffter/.test(q))                              KEY_STUDIES.psilocybin_eol.forEach(id => ids.add(id));
  if (/psilocybin.*(trial|study|research)|trial.*psilocybin/.test(q)) KEY_STUDIES.psilocybin_eol.forEach(id => ids.add(id));
  if (/ketamine.*(eol|end.of.life|palliative)|eol.*ketamine/.test(q)) KEY_STUDIES.ketamine_eol.forEach(id => ids.add(id));

  return [...ids];
}

async function searchPubMed(query) {
  // First: check for known studies — fetch by PMID directly
  const knownIds = detectKeyStudies(query);

  // Then: keyword-based search for additional results
  const searchTerm = extractMedicalTerms(query);
  const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(searchTerm)}&retmax=3&retmode=json&sort=relevance`;
  const sr = await fetch(searchUrl);
  const sd = await sr.json();
  const searchIds = sd?.esearchresult?.idlist || [];

  // Combine: known studies first, then keyword results, deduplicated
  const allIds = [...new Set([...knownIds, ...searchIds])].slice(0, 5);
  if (!allIds.length) return [];

  const fetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${allIds.join(',')}&rettype=abstract&retmode=xml`;
  const fr = await fetch(fetchUrl);
  const xml = await fr.text();

  const RELEVANCE_TERMS = /psilocybin|ketamine|psychedelic|hallucinogen|palliative|hospice|end.of.life|mdma|lsd|cannabis|cannabinoid|ibogaine|ayahuasca|psilocin|psychotomimetic/i;

  return [...xml.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g)].map(m => {
    const c = m[1];
    const title    = (c.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/)    ||[])[1]?.replace(/<[^>]+>/g,'').trim() || '';
    const abstract = (c.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/)    ||[])[1]?.replace(/<[^>]+>/g,'').trim() || '';
    const pmid     = (c.match(/<PMID[^>]*>(\d+)<\/PMID>/)                         ||[])[1] || '';
    const year     = (c.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/)           ||[])[1] || '';
    const journal  = (c.match(/<ISOAbbreviation>([^<]+)<\/ISOAbbreviation>/)      ||[])[1] || '';
    const doi      = (c.match(/<ELocationID EIdType="doi"[^>]*>([^<]+)<\/ELocationID>/) ||[])[1] || '';
    const authorTags = [...c.matchAll(/<Author[^>]*>([\s\S]*?)<\/Author>/g)];
    const authors  = authorTags.slice(0,3).map(a => {
      const l = (a[1].match(/<LastName>([^<]+)/) ||[])[1] || '';
      const i = (a[1].match(/<Initials>([^<]+)/) ||[])[1] || '';
      return `${l} ${i}`.trim();
    }).filter(Boolean).join(', ') + (authorTags.length > 3 ? ' et al.' : '');
    // Only keep papers that mention relevant terms — prevents irrelevant keyword matches
    const isRelevant = RELEVANCE_TERMS.test(title) || RELEVANCE_TERMS.test(abstract);
    return title && abstract && pmid && isRelevant ? { title, abstract, pmid, year, authors, journal, doi, source: 'pubmed' } : null;
  }).filter(Boolean);
}

// ── Semantic Scholar ───────────────────────────────────────────────────────

async function searchSemanticScholar(query) {
  const q = `${query} psychedelic palliative end of life`;
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&fields=title,abstract,year,authors,externalIds,journal&limit=3`;
  const r = await fetch(url, { headers: { 'User-Agent': 'EOLPC-Demo/1.0 (eolpc.org research@eolpc.org)' } });
  const d = await r.json();
  const EOL_FILTER = /palliative|hospice|end.of.life|terminal|dying|death|oncol|cancer|existential/i;
  return (d.data || [])
    .filter(p => p.abstract)
    .filter(p => EOL_FILTER.test((p.title || '') + ' ' + (p.abstract || '')))
    .map(p => ({
    title:    p.title || '',
    abstract: p.abstract || '',
    year:     p.year || '',
    authors:  (p.authors || []).slice(0,3).map(a => a.name).join(', ') + ((p.authors||[]).length > 3 ? ' et al.' : ''),
    journal:  p.journal?.name || '',
    doi:      p.externalIds?.DOI || '',
    pmid:     p.externalIds?.PubMed || '',
    url:      `https://www.semanticscholar.org/paper/${p.paperId}`,
    source:   'semantic',
  }));
}

// ── Europe PMC ────────────────────────────────────────────────────────────

async function searchEuropePMC(query) {
  const q = `${query} AND (psilocybin OR ketamine OR psychedelic) AND (palliative OR "end of life" OR hospice)`;
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}&format=json&pageSize=3&resulttype=core`;
  const r = await fetch(url);
  const d = await r.json();
  const EOL_TERMS = /palliative|hospice|end.of.life|terminal|dying|death|oncol|cancer|existential|bereavement/i;

  return ((d.resultList || {}).result || [])
    .filter(p => p.abstractText)
    .filter(p => {
      // Require BOTH psychedelic relevance AND EOL/palliative relevance
      const text = (p.title || '') + ' ' + (p.abstractText || '');
      const hasPsychedelic = /psilocybin|ketamine|psychedelic|mdma|lsd|hallucinogen/i.test(text);
      const hasEOL = EOL_TERMS.test(text);
      return hasPsychedelic && hasEOL;
    })
    .map(p => ({
    title:    p.title || '',
    abstract: p.abstractText || '',
    year:     p.pubYear || '',
    authors:  p.authorString?.split(',').slice(0,3).join(',') + (p.authorString?.includes(',') ? ' et al.' : '') || '',
    journal:  p.journalTitle || '',
    doi:      p.doi || '',
    pmid:     p.pmid || '',
    url:      p.doi ? `https://doi.org/${p.doi}` : `https://europepmc.org/article/MED/${p.pmid}`,
    source:   'europepmc',
  }));
}

// ── ClinicalTrials.gov ─────────────────────────────────────────────────────

async function searchClinicalTrials(query) {
  const term = 'psilocybin OR ketamine psychedelic palliative hospice end of life';
  const url = `https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(term)}&pageSize=3&format=json`;
  const r = await fetch(url);
  const d = await r.json();
  return (d.studies || []).map(s => {
    const id     = s.protocolSection?.identificationModule || {};
    const status = s.protocolSection?.statusModule || {};
    const desc   = s.protocolSection?.descriptionModule || {};
    const design = s.protocolSection?.designModule || {};
    return {
      title:  id.briefTitle || '',
      nctId:  id.nctId || '',
      status: status.overallStatus || '',
      phase:  (design.phases || []).join('/') || 'N/A',
      brief:  (desc.briefSummary || '').slice(0, 350),
      url:    `https://clinicaltrials.gov/study/${id.nctId}`,
      source: 'trials',
    };
  }).filter(t => t.title);
}

// ── Exa ────────────────────────────────────────────────────────────────────

async function searchExa(query) {
  const key = process.env.EXA_API_KEY;
  if (!key) return [];
  const r = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({
      query: `${query} EOLPC psychedelic end of life palliative care`,
      numResults: 4,
      highlights: { numSentences: 3, highlightsPerUrl: 1 },
      contents: { text: { maxCharacters: 500 } },
    })
  });
  const d = await r.json();
  return (d.results || []).map(p => ({
    title:         p.title || '',
    url:           p.url || '',
    highlights:    p.highlights || [],
    text:          (p.text || '').slice(0, 400),
    publishedDate: p.publishedDate || '',
    source:        'exa',
  }));
}

// ── Gemini synthesis ───────────────────────────────────────────────────────

function synthesize(query, results, totalSources) {
  // No external API needed — build a clean lead sentence from the top results

  if (totalSources === 0) {
    return 'No relevant sources found across PubMed, Semantic Scholar, Europe PMC, ClinicalTrials.gov, or the web for this query. Try rephrasing with more specific clinical terms.';
  }

  const parts = [];

  // Lead with top academic result
  const topAcademic = results.pubmed[0] || results.semantic[0] || results.europepmc[0];
  if (topAcademic && topAcademic.abstract) {
    // Extract first 2 sentences of the abstract
    const sentences = topAcademic.abstract.match(/[^.!?]+[.!?]+/g) || [];
    const lead = sentences.slice(0, 2).join(' ').trim();
    if (lead) {
      parts.push(`${topAcademic.authors ? topAcademic.authors + ' (' + topAcademic.year + ')' : ''}: ${lead}`);
    }
  }

  // Add trial context if any active trials
  if (results.trials.length > 0) {
    parts.push(`${results.trials.length} active clinical trial${results.trials.length > 1 ? 's' : ''} currently registered on ClinicalTrials.gov for this area.`);
  }

  // Add Exa context if EOLPC-specific
  if (results.exa.length > 0 && results.exa[0].highlights && results.exa[0].highlights.length > 0) {
    const h = results.exa[0].highlights[0];
    if (h && h.length > 40) parts.push(h);
  }

  const totalDbs = [results.pubmed.length > 0 ? 'PubMed' : '',
    results.semantic.length > 0 ? 'Semantic Scholar' : '',
    results.europepmc.length > 0 ? 'Europe PMC' : '',
    results.trials.length > 0 ? 'ClinicalTrials.gov' : '',
    results.exa.length > 0 ? 'Exa' : ''].filter(Boolean);

  parts.push(`${totalSources} source${totalSources !== 1 ? 's' : ''} retrieved from: ${totalDbs.join(', ')}. Full details below.`);

  return parts.join(' ');
}

// ── Logging ────────────────────────────────────────────────────────────────

async function logAndNotify({ query, type, visitorId, synthesis }) {
  const ts = new Date().toISOString();
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    const val = encodeURIComponent(JSON.stringify({ ts, query, type, visitorId, synthesis }));
    fetch(`${url}/lpush/eolpc:queries/${val}`, { headers: { Authorization: `Bearer ${token}` } }).catch(()=>{});
  }
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (webhook) {
    const icon = type === 'C' ? '🚫' : '🔍';
    fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `${icon} *EOLPC demo — ${type === 'C' ? 'declined' : 'query'}*\n*Q:* ${query.slice(0,200)}` }) }).catch(()=>{});
  }
}
