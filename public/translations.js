'use strict';

// translations.js — Strategic Flow Audit i18n
// Supports: en, es, sv, fr, ro, de
// Usage: initI18n(namespace, containerId)
// getLang() returns current language code

var SF_TRANSLATIONS = {
  en: {
    shared: {
      before:       'Before',
      after:        'After',
      runAudit:     'Run Audit',
      loading:      'Analyzing...',
      whatChanged:  'Strategic Flow — Changelog Audit: What Changed & Why',
      copy:         'Copy',
      downloadHTML: 'Download',
      urlPlaceholder: 'e.g. linear.app/changelog or getdbt.com/blog',
    },
    changelog: {
      pageTitle:        'Changelog Audit — Strategic Flow',
      inputLabel:       'Step 2 — Paste changelog text',
      inputPlaceholder: 'Paste the full changelog text here — title, all entries, CTAs. The more text, the better the audit.',
    },
    onboarding: {
      pageTitle:        'Onboarding Audit — Strategic Flow',
      inputLabel:       'Step 2 — Paste onboarding copy',
      inputPlaceholder: 'Paste all onboarding copy here — welcome screen, setup steps, tooltips, empty states, CTAs, error messages.',
    },
    linkedin: {
      pageTitle:        'LinkedIn Post Audit — Strategic Flow',
      inputLabel:       'Paste your LinkedIn post',
      inputPlaceholder: 'Paste the full LinkedIn post here — hook, body, CTA, hashtags.',
    },
  },

  es: {
    shared: {
      before:       'Antes',
      after:        'Después',
      runAudit:     'Ejecutar Auditoría',
      loading:      'Analizando...',
      whatChanged:  'Strategic Flow — Auditoría de Changelog: Qué Cambió y Por Qué',
      copy:         'Copiar',
      downloadHTML: 'Descargar',
      urlPlaceholder: 'ej. linear.app/changelog o getdbt.com/blog',
    },
    changelog: {
      pageTitle:        'Auditoría de Changelog — Strategic Flow',
      inputLabel:       'Paso 2 — Pega el texto del changelog',
      inputPlaceholder: 'Pega el texto completo del changelog aquí — título, todas las entradas, CTAs. Más texto = mejor auditoría.',
    },
    onboarding: {
      pageTitle:        'Auditoría de Onboarding — Strategic Flow',
      inputLabel:       'Paso 2 — Pega el copy de onboarding',
      inputPlaceholder: 'Pega todo el copy de onboarding aquí — pantalla de bienvenida, pasos de configuración, tooltips, estados vacíos, CTAs.',
    },
    linkedin: {
      pageTitle:        'Auditoría de Post LinkedIn — Strategic Flow',
      inputLabel:       'Pega tu post de LinkedIn',
      inputPlaceholder: 'Pega el post completo de LinkedIn aquí — gancho, cuerpo, CTA, hashtags.',
    },
  },

  sv: {
    shared: {
      before:       'Innan',
      after:        'Efter',
      runAudit:     'Kör Granskning',
      loading:      'Analyserar...',
      whatChanged:  'Strategic Flow — Changelog-granskning: Vad Ändrades och Varför',
      copy:         'Kopiera',
      downloadHTML: 'Ladda ner',
      urlPlaceholder: 't.ex. linear.app/changelog eller getdbt.com/blog',
    },
    changelog: {
      pageTitle:        'Changelog-granskning — Strategic Flow',
      inputLabel:       'Steg 2 — Klistra in changelog-text',
      inputPlaceholder: 'Klistra in hela changelog-texten här — titel, alla poster, CTAs. Mer text = bättre granskning.',
    },
    onboarding: {
      pageTitle:        'Onboarding-granskning — Strategic Flow',
      inputLabel:       'Steg 2 — Klistra in onboarding-text',
      inputPlaceholder: 'Klistra in all onboarding-text här — välkomstskärm, installationssteg, verktygstips, tomma tillstånd, CTAs.',
    },
    linkedin: {
      pageTitle:        'LinkedIn-inläggsgranskning — Strategic Flow',
      inputLabel:       'Klistra in ditt LinkedIn-inlägg',
      inputPlaceholder: 'Klistra in hela LinkedIn-inlägget här — krok, brödtext, CTA, hashtags.',
    },
  },

  fr: {
    shared: {
      before:       'Avant',
      after:        'Après',
      runAudit:     'Lancer l\'audit',
      loading:      'Analyse en cours...',
      whatChanged:  'Strategic Flow — Audit Changelog : Ce qui a changé et pourquoi',
      copy:         'Copier',
      downloadHTML: 'Télécharger',
      urlPlaceholder: 'ex. linear.app/changelog ou getdbt.com/blog',
    },
    changelog: {
      pageTitle:        'Audit Changelog — Strategic Flow',
      inputLabel:       'Étape 2 — Coller le texte du changelog',
      inputPlaceholder: 'Collez ici le texte complet du changelog — titre, toutes les entrées, CTAs. Plus il y a de texte, meilleur est l\'audit.',
    },
    onboarding: {
      pageTitle:        'Audit Onboarding — Strategic Flow',
      inputLabel:       'Étape 2 — Coller le texte d\'onboarding',
      inputPlaceholder: 'Collez ici tout le texte d\'onboarding — écran de bienvenue, étapes de configuration, infobulles, états vides, CTAs.',
    },
    linkedin: {
      pageTitle:        'Audit Post LinkedIn — Strategic Flow',
      inputLabel:       'Collez votre post LinkedIn',
      inputPlaceholder: 'Collez ici le post LinkedIn complet — accroche, corps, CTA, hashtags.',
    },
  },

  ro: {
    shared: {
      before:       'Înainte',
      after:        'După',
      runAudit:     'Rulează Auditul',
      loading:      'Se analizează...',
      whatChanged:  'Strategic Flow — Audit Changelog: Ce s-a Schimbat și De Ce',
      copy:         'Copiază',
      downloadHTML: 'Descarcă',
      urlPlaceholder: 'ex. linear.app/changelog sau getdbt.com/blog',
    },
    changelog: {
      pageTitle:        'Audit Changelog — Strategic Flow',
      inputLabel:       'Pasul 2 — Lipește textul changelog-ului',
      inputPlaceholder: 'Lipește textul complet al changelog-ului aici — titlu, toate intrările, CTA-uri. Cu cât mai mult text, cu atât mai bun auditul.',
    },
    onboarding: {
      pageTitle:        'Audit Onboarding — Strategic Flow',
      inputLabel:       'Pasul 2 — Lipește textul de onboarding',
      inputPlaceholder: 'Lipește tot textul de onboarding aici — ecran de bun venit, pași de configurare, tooltip-uri, stări goale, CTA-uri.',
    },
    linkedin: {
      pageTitle:        'Audit Post LinkedIn — Strategic Flow',
      inputLabel:       'Lipește postarea ta LinkedIn',
      inputPlaceholder: 'Lipește postarea completă LinkedIn aici — cârlig, corp, CTA, hashtag-uri.',
    },
  },

  de: {
    shared: {
      before:       'Vorher',
      after:        'Nachher',
      runAudit:     'Analyse starten',
      loading:      'Wird analysiert...',
      whatChanged:  'Strategic Flow — Changelog-Audit: Was sich geändert hat und warum',
      copy:         'Kopieren',
      downloadHTML: 'Herunterladen',
      urlPlaceholder: 'z.B. linear.app/changelog oder getdbt.com/blog',
    },
    changelog: {
      pageTitle:        'Changelog-Audit — Strategic Flow',
      inputLabel:       'Schritt 2 — Changelog-Text einfügen',
      inputPlaceholder: 'Fügen Sie hier den vollständigen Changelog-Text ein — Titel, alle Einträge, CTAs. Mehr Text = besserer Audit.',
    },
    onboarding: {
      pageTitle:        'Onboarding-Audit — Strategic Flow',
      inputLabel:       'Schritt 2 — Onboarding-Text einfügen',
      inputPlaceholder: 'Fügen Sie hier den gesamten Onboarding-Text ein — Willkommensbildschirm, Einrichtungsschritte, Tooltips, leere Zustände, CTAs.',
    },
    linkedin: {
      pageTitle:        'LinkedIn-Post-Audit — Strategic Flow',
      inputLabel:       'LinkedIn-Post einfügen',
      inputPlaceholder: 'Fügen Sie hier den vollständigen LinkedIn-Post ein — Hook, Text, CTA, Hashtags.',
    },
  },
};

var SF_LANG_NAMES = {
  en: 'English',
  es: 'Español',
  sv: 'Svenska',
  fr: 'Français',
  ro: 'Română',
  de: 'Deutsch',
};

var _sfCurrentLang = 'en';

function getLang() {
  return _sfCurrentLang;
}

function _getNestedKey(obj, keyPath) {
  var parts = keyPath.split('.');
  var cur = obj;
  for (var i = 0; i < parts.length; i++) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[parts[i]];
  }
  return (cur != null && typeof cur === 'string') ? cur : null;
}

function _applyTranslations(namespace, lang) {
  var dict = SF_TRANSLATIONS[lang] || SF_TRANSLATIONS['en'];

  // data-i18n: set textContent
  var nodes = document.querySelectorAll('[data-i18n]');
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var keyPath = el.getAttribute('data-i18n');
    // Try namespace-scoped key first, then shared, then bare key
    var parts = keyPath.split('.');
    var val = null;
    if (parts.length === 2) {
      // e.g. "shared.before" or "changelog.pageTitle"
      val = _getNestedKey(dict, keyPath);
      if (val == null) {
        // try with provided namespace
        val = _getNestedKey(dict, namespace + '.' + parts[1]);
      }
    } else {
      val = _getNestedKey(dict, keyPath) || _getNestedKey(dict, namespace + '.' + keyPath);
    }
    if (val != null) {
      if (el.tagName === 'TITLE') {
        document.title = val;
      } else {
        el.textContent = val;
      }
    }
  }

  // data-i18n-placeholder: set placeholder attribute
  var pnodes = document.querySelectorAll('[data-i18n-placeholder]');
  for (var j = 0; j < pnodes.length; j++) {
    var pel = pnodes[j];
    var pkeyPath = pel.getAttribute('data-i18n-placeholder');
    var pparts = pkeyPath.split('.');
    var pval = null;
    if (pparts.length === 2) {
      pval = _getNestedKey(dict, pkeyPath);
      if (pval == null) {
        pval = _getNestedKey(dict, namespace + '.' + pparts[1]);
      }
    } else {
      pval = _getNestedKey(dict, pkeyPath) || _getNestedKey(dict, namespace + '.' + pkeyPath);
    }
    if (pval != null) {
      pel.setAttribute('placeholder', pval);
    }
  }
}

function _buildSelector(namespace, containerId, lang) {
  var container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = '';

  var wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:relative;display:inline-flex;align-items:center;';

  var sel = document.createElement('select');
  sel.id = 'sf-lang-select';
  sel.style.cssText = [
    'appearance:none;-webkit-appearance:none;',
    'background:rgba(255,255,255,.10);',
    'border:1px solid rgba(255,255,255,.20);',
    'border-radius:6px;',
    'color:#fff;',
    'font-family:inherit;',
    'font-size:11px;',
    'font-weight:600;',
    'letter-spacing:.04em;',
    'padding:4px 24px 4px 8px;',
    'cursor:pointer;',
    'outline:none;',
    'text-transform:uppercase;',
    'transition:border-color .15s;',
  ].join('');

  var langs = Object.keys(SF_LANG_NAMES);
  for (var i = 0; i < langs.length; i++) {
    var opt = document.createElement('option');
    opt.value = langs[i];
    opt.textContent = SF_LANG_NAMES[langs[i]];
    if (langs[i] === lang) opt.selected = true;
    sel.appendChild(opt);
  }

  // Arrow icon
  var arrow = document.createElement('span');
  arrow.textContent = '▾';
  arrow.style.cssText = 'position:absolute;right:7px;top:50%;transform:translateY(-50%);font-size:9px;color:rgba(255,255,255,.5);pointer-events:none;';

  sel.addEventListener('change', function() {
    var chosen = sel.value;
    _sfCurrentLang = chosen;
    try { localStorage.setItem('sf_lang', chosen); } catch(e) {}
    _applyTranslations(namespace, chosen);
  });

  sel.addEventListener('focus', function() { sel.style.borderColor = 'rgba(255,255,255,.45)'; });
  sel.addEventListener('blur',  function() { sel.style.borderColor = 'rgba(255,255,255,.20)'; });

  wrapper.appendChild(sel);
  wrapper.appendChild(arrow);
  container.appendChild(wrapper);
}

function initI18n(namespace, containerId) {
  // Detect language: localStorage → browser → fallback en
  var saved = null;
  try { saved = localStorage.getItem('sf_lang'); } catch(e) {}
  var detected = saved || (navigator.language || navigator.userLanguage || 'en').slice(0, 2).toLowerCase();
  var lang = SF_TRANSLATIONS[detected] ? detected : 'en';
  _sfCurrentLang = lang;
  try { localStorage.setItem('sf_lang', lang); } catch(e) {}

  _buildSelector(namespace, containerId, lang);
  _applyTranslations(namespace, lang);
}
