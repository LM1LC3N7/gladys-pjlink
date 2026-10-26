// -----------------------------------------------------------------------------
// Texts shown to the user (action messages, connection status), in English and
// French. Never a password in them.
// -----------------------------------------------------------------------------

const list = (names) => names.join(', ');
const both = (en, fr) => ({ en, fr });

const FR_LABELS = {
  Standby: 'en veille',
  On: 'allumé',
  'Cooling down': 'en refroidissement',
  'Warming up': 'en préchauffage',
};

export const T = {
  dataReset: both(
    'The saved data of the integration was unreadable: it was moved to pjlink.json.bad, and the projectors are identified again.',
    "Les données enregistrées de l'intégration étaient illisibles : elles ont été déplacées dans pjlink.json.bad, et les vidéoprojecteurs sont identifiés à nouveau.",
  ),
  dataUnreadable: both(
    'The saved data of the integration (/data/pjlink.json) cannot be read: it is left as is and nothing is saved until it can be (check the volume of the integration).',
    "Les données enregistrées de l'intégration (/data/pjlink.json) ne peuvent pas être lues : elles sont laissées telles quelles et rien n'est enregistré tant qu'elles ne le peuvent pas (vérifiez le volume de l'intégration).",
  ),
  saveFailed: both(
    'The integration cannot save its data (/data): a standby not confirmed yet would not survive a restart.',
    "L'intégration ne peut pas enregistrer ses données (/data) : une mise en veille pas encore confirmée ne survivrait pas à un redémarrage.",
  ),
  configUnread: both(
    'The configuration could not be read from Gladys: tried again shortly.',
    "La configuration n'a pas pu être lue depuis Gladys : nouvel essai sous peu.",
  ),
  invalidEntries: (entries) =>
    both(
      `Ignored in the configuration (invalid): ${list(entries)}.`,
      `Ignoré dans la configuration (invalide) : ${list(entries)}.`,
    ),
  passwordInvalid: both(
    'The password of the configuration cannot be used: PJLink accepts 32 characters at most, without accents. It is ignored.',
    'Le mot de passe de la configuration est inutilisable : PJLink accepte 32 caractères au plus, sans accents. Il est ignoré.',
  ),
  authRequired: (names) =>
    both(
      `A PJLink password is set on: ${list(names)}. Type it in the configuration; nothing is sent there until then (or until "Check the projectors" succeeds).`,
      `Un mot de passe PJLink est défini sur : ${list(names)}. Saisissez-le dans la configuration ; rien n'y est envoyé d'ici là (ou jusqu'à ce que « Vérifier les vidéoprojecteurs » réussisse).`,
    ),
  authRefused: (names) =>
    both(
      `Password refused by: ${list(names)}. Change it in the configuration; it is not tried again until then (or until "Check the projectors" succeeds).`,
      `Mot de passe refusé par : ${list(names)}. Changez-le dans la configuration ; il n'est pas réessayé d'ici là (ou jusqu'à ce que « Vérifier les vidéoprojecteurs » réussisse).`,
    ),
  noAnswerAt: (addresses) =>
    both(
      `No PJLink projector answers at: ${list(addresses)} (tried again every minute).`,
      `Aucun vidéoprojecteur PJLink ne répond à : ${list(addresses)} (nouvel essai chaque minute).`,
    ),
  unreachable: (names) =>
    both(
      `Unreachable (off, standby without network, or wrong address): ${list(names)}.`,
      `Injoignables (éteints, en veille sans réseau, ou mauvaise adresse) : ${list(names)}.`,
    ),
  identityProblem: (names) =>
    both(
      `Identity not confirmed (serial number, maker or model unreadable or different: maybe another projector at the address); nothing is sent to it but Standby, nothing published: ${list(names)}. Checked again at each reading.`,
      `Identité non confirmée (numéro de série, marque ou modèle illisible ou différent : peut-être un autre vidéoprojecteur à l'adresse) ; rien ne lui est envoyé sauf la mise en veille, rien n'est publié : ${list(names)}. Revérifié à chaque lecture.`,
    ),
  addressUnknown: (names) =>
    both(
      `Another projector now answers at the address of: ${list(names)}. Type its new address, then scan again in the Discovery tab.`,
      `Un autre vidéoprojecteur répond maintenant à l'adresse de : ${list(names)}. Saisissez sa nouvelle adresse, puis relancez la recherche dans l'onglet Découverte.`,
    ),
  standbyPending: (names) =>
    both(
      `Standby not confirmed yet, sent again at the next readings (3 times at most, for 10 minutes): ${list(names)}.`,
      `Mise en veille pas encore confirmée, renvoyée aux prochaines lectures (3 fois au plus, pendant 10 minutes) : ${list(names)}.`,
    ),
  noProjector: both(
    'No projector known yet: type their address in the configuration, then scan in the Discovery tab.',
    "Aucun vidéoprojecteur connu pour l'instant : saisissez leur adresse dans la configuration, puis lancez la recherche dans l'onglet Découverte.",
  ),
  check: (lines) => both(lines.map((l) => l.en).join(' · '), lines.map((l) => l.fr).join(' · ')),
  checkLine: (label, reading, problem) => {
    if (problem) {
      return both(`${label}: ${problem.en}`, `${label} : ${problem.fr}`);
    }
    if (!reading) {
      return both(`${label}: no answer yet`, `${label} : pas encore de réponse`);
    }
    if (reading.identity) {
      return both(`${label}: identity not confirmed`, `${label} : identité non confirmée`);
    }
    if (reading.reachable === false) {
      return both(`${label}: unreachable`, `${label} : injoignable`);
    }
    const en = [reading.power?.label ?? 'state unknown'];
    const fr = [FR_LABELS[reading.power?.label] ?? 'état inconnu'];
    if (Number.isInteger(reading.lampHours)) {
      en.push(`lamp ${reading.lampHours} h`);
      fr.push(`lampe ${reading.lampHours} h`);
    }
    return both(`${label}: ${en.join(', ')}`, `${label} : ${fr.join(', ')}`);
  },
  found: both('found, in the Discovery tab', "trouvé, dans l'onglet Découverte"),
  notKept: both(
    'answers, but not kept (see the integration logs)',
    "répond, mais n'est pas gardé (voir les journaux de l'intégration)",
  ),
  noAnswer: both('no PJLink answer', 'pas de réponse PJLink'),
  passwordProblem: both('password missing or refused', 'mot de passe manquant ou refusé'),
};
