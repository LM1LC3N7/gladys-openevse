// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and state names, the status of
// the integration, the answers of the buttons and the command errors. None of
// them ever carries the user name or the password.
// -----------------------------------------------------------------------------

import { FEATURES, OVERRIDE, STATE } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

const kwh = (value) => String(Math.round(value * 1000) / 1000);
const kwhFr = (value) => kwh(value).replace('.', ',');

export const FEATURE_NAMES = {
  [FEATURES.STATUS]: both('Status', 'État'),
  [FEATURES.CONNECTOR]: both('Connector', 'Connecteur'),
  [FEATURES.CHARGING_STATE]: both('Charging state', 'État de charge'),
  [FEATURES.PLUGGED]: both('Vehicle plugged in', 'Véhicule branché'),
  [FEATURES.POWER]: both('Power', 'Puissance'),
  [FEATURES.CURRENT]: both('Current', 'Courant'),
  [FEATURES.VOLTAGE]: both('Voltage', 'Tension'),
  [FEATURES.PILOT]: both('Current offered to the vehicle', 'Courant proposé au véhicule'),
  [FEATURES.SESSION_ENERGY]: both('Energy of the session', 'Énergie de la session'),
  [FEATURES.TOTAL_ENERGY]: both('Energy index', "Index d'énergie"),
  [FEATURES.TEMPERATURE]: both('Temperature of the charger', 'Température de la borne'),
  [FEATURES.OVERRIDE]: both('Manual override', 'Forçage manuel'),
  [FEATURES.ERROR]: both('Fault reported', 'Défaut signalé'),
  [FEATURES.START]: both('Start charging', 'Démarrer la charge'),
  [FEATURES.PAUSE]: both('Pause charging', 'Mettre la charge en pause'),
  [FEATURES.SET_CURRENT]: both('Set the charging current', 'Régler le courant de charge'),
};

export const STATE_NAMES = {
  [STATE.UNKNOWN]: both('Unknown state', 'État inconnu'),
  [STATE.NO_EV]: both('No vehicle', 'Aucun véhicule'),
  [STATE.CONNECTED]: both('Vehicle plugged in, waiting', 'Véhicule branché, en attente'),
  [STATE.CHARGING]: both('Charging', 'En charge'),
  [STATE.VENT_REQUIRED]: both('Fault: ventilation required', 'Défaut : ventilation requise'),
  [STATE.DIODE_CHECK]: both('Fault: diode check failed', 'Défaut : test de la diode échoué'),
  [STATE.GFCI_FAULT]: both('Fault: ground fault (GFCI)', 'Défaut : fuite à la terre (GFCI)'),
  [STATE.NO_GROUND]: both('Fault: no ground', 'Défaut : pas de terre'),
  [STATE.STUCK_RELAY]: both('Fault: stuck relay', 'Défaut : relais collé'),
  [STATE.GFCI_SELF_TEST]: both('Fault: GFCI self-test failed', 'Défaut : autotest du GFCI échoué'),
  [STATE.OVER_TEMPERATURE]: both('Fault: over temperature', 'Défaut : surchauffe'),
  [STATE.SLEEPING]: both('Paused (sleeping)', 'En pause (veille)'),
  [STATE.DISABLED]: both('Disabled', 'Désactivée'),
  [STATE.OFFLINE]: both('Charger unreachable', 'Borne injoignable'),
  /** Asleep with a vehicle plugged in: the charge is paused. */
  pausedPlugged: both('Vehicle plugged in, charge paused', 'Véhicule branché, charge en pause'),
};

export const OVERRIDE_NAMES = {
  [OVERRIDE.NONE]: both('None (the charger decides)', 'Aucun (la borne décide)'),
  [OVERRIDE.ACTIVE]: both('Charge forced on', 'Charge forcée'),
  [OVERRIDE.DISABLED]: both('Charge paused', 'Charge en pause'),
};

/** The index held back by the guard (src/guard.js), for the status. */
export function held({ direction, from, to }) {
  return direction === 'down'
    ? both(
        `Energy index held back: it dropped from ${kwh(from)} to ${kwh(to)} kWh. "Accept the held index" (configuration, two clicks) takes it, 0 kWh billed.`,
        `Index d'énergie retenu : baisse de ${kwhFr(from)} à ${kwhFr(to)} kWh. « Accepter l'index retenu » (configuration, deux clics) la prend, 0 kWh facturé.`,
      )
    : both(
        `Energy index held back: it jumped from ${kwh(from)} to ${kwh(to)} kWh. "Accept the held index" (configuration, two clicks) would count ${kwh(to - from)} kWh at once.`,
        `Index d'énergie retenu : saut de ${kwhFr(from)} à ${kwhFr(to)} kWh. « Accepter l'index retenu » (configuration, deux clics) compterait ${kwhFr(to - from)} kWh d'un coup.`,
      );
}

/** The integration status, the buttons and the logs a user may read. */
export const T = {
  noHost: both(
    'Enter the IP address of your OpenEVSE charger (and the user name and password of its web interface if it has some), then save.',
    "Saisissez l'adresse IP de votre borne OpenEVSE (et le nom d'utilisateur et le mot de passe de son interface web si elle en a), puis enregistrez.",
  ),
  invalidHost: (typed) =>
    both(
      `"${typed}" is not an IP address nor a host name.`,
      `« ${typed} » n'est ni une adresse IP ni un nom d'hôte.`,
    ),
  incompleteAuth: both(
    'Enter both the user name and the password of the web interface, or neither, then save.',
    "Saisissez à la fois le nom d'utilisateur et le mot de passe de l'interface web, ou aucun des deux, puis enregistrez.",
  ),
  invalidAuth: both(
    'The user name or the password holds characters that are not accepted (plain ASCII only, 256 at most, no colon in the user name).',
    "Le nom d'utilisateur ou le mot de passe contient des caractères refusés (ASCII simple seulement, 256 au plus, pas de deux-points dans le nom).",
  ),
  connecting: both('Reading the charger…', 'Lecture de la borne…'),
  connected: (summary) => both(`Connected. ${summary.en}`, `Connecté. ${summary.fr}`),
  unreachable: (host, wait) =>
    both(
      `No answer from ${host} (next try in ${wait.en}). Check the address and that the charger is on the network.`,
      `Pas de réponse de ${host} (nouvel essai dans ${wait.fr}). Vérifiez l'adresse et que la borne est sur le réseau.`,
    ),
  failing: (reason, wait) =>
    both(
      `The charger answers with an error (${reason}): next try in ${wait.en}.`,
      `La borne répond par une erreur (${reason}) : nouvel essai dans ${wait.fr}.`,
    ),
  rateLimited: (wait) =>
    both(
      `The charger asks to slow down (HTTP 429): pause of ${wait.en}.`,
      `La borne demande de ralentir (HTTP 429) : pause de ${wait.fr}.`,
    ),
  serverError: (wait) =>
    both(
      `The charger answered with a server error (HTTP 5xx): pause of ${wait.en}.`,
      `La borne a répondu par une erreur serveur (HTTP 5xx) : pause de ${wait.fr}.`,
    ),
  authRefused: (wait) =>
    both(
      `The charger refused the user name and password of its web interface: check them, then save. Next try in ${wait.en}.`,
      `La borne a refusé le nom d'utilisateur et le mot de passe de son interface web : vérifiez-les, puis enregistrez. Nouvel essai dans ${wait.fr}.`,
    ),
  authAsked: (wait) =>
    both(
      `The charger asks for a user name and a password (those of its web interface): enter them, then save. Next try in ${wait.en}.`,
      `La borne demande un nom d'utilisateur et un mot de passe (ceux de son interface web) : saisissez-les, puis enregistrez. Nouvel essai dans ${wait.fr}.`,
    ),
  noId: both(
    'The charger gave no serial number (`wifi_serial`): an OpenEVSE WiFi firmware 4.0 or later is needed.',
    "La borne n'a pas donné de numéro de série (`wifi_serial`) : un firmware WiFi OpenEVSE 4.0 ou plus récent est nécessaire.",
  ),
  oldFirmware: both(
    'The WiFi firmware of the charger is older than 4.1.2: start and the charging current are refused.',
    'Le firmware WiFi de la borne est antérieur à 4.1.2 : le démarrage et le courant de charge sont refusés.',
  ),
  otherCharger: (names) =>
    both(
      `Not read any more: ${names} (another charger answers at this address, or it was removed).`,
      `Plus lue : ${names} (une autre borne répond à cette adresse, ou elle a été retirée).`,
    ),
  held,
  test: {
    cooldown: both('Tested less than 10 s ago.', 'Testé il y a moins de 10 s.'),
  },
  /** The answers of the "Accept the held index" action (two clicks). */
  accept: {
    nothing: both(
      'No energy index is held back: nothing to accept.',
      "Aucun index d'énergie n'est retenu : rien à accepter.",
    ),
    confirm: ({ direction, from, to }) =>
      direction === 'down'
        ? both(
            `Nothing accepted yet. Held back: a drop from ${kwh(from)} to ${kwh(to)} kWh (a reset of the counter?). Accepting bills nothing and the index starts again from there. If this value is right, click "Accept the held index" again within 2 minutes.`,
            `Rien n'est encore accepté. Retenu : une baisse de ${kwhFr(from)} à ${kwhFr(to)} kWh (une remise à zéro du compteur ?). Accepter ne facture rien et l'index repart de là. Si cette valeur est juste, cliquez à nouveau sur « Accepter l'index retenu » dans les 2 minutes.`,
          )
        : both(
            `Nothing accepted yet. Held back: a jump from ${kwh(from)} to ${kwh(to)} kWh. Accepting would count ${kwh(to - from)} kWh at once as consumption. If this value is right, click "Accept the held index" again within 2 minutes.`,
            `Rien n'est encore accepté. Retenu : un saut de ${kwhFr(from)} à ${kwhFr(to)} kWh. Accepter compterait ${kwhFr(to - from)} kWh d'un coup comme consommation. Si cette valeur est juste, cliquez à nouveau sur « Accepter l'index retenu » dans les 2 minutes.`,
          ),
    done: ({ direction, from, to }) =>
      direction === 'down'
        ? both(
            `Accepted: the drop from ${kwh(from)} to ${kwh(to)} kWh. Nothing is billed; the index goes on from there. A different value stays held.`,
            `Accepté : la baisse de ${kwhFr(from)} à ${kwhFr(to)} kWh. Rien n'est facturé ; l'index repart de là. Une autre valeur reste retenue.`,
          )
        : both(
            `Accepted: the jump from ${kwh(from)} to ${kwh(to)} kWh. ${kwh(to - from)} kWh will be counted at once as consumption (plus what the charger uses meanwhile). A different value stays held.`,
            `Accepté : le saut de ${kwhFr(from)} à ${kwhFr(to)} kWh. ${kwhFr(to - from)} kWh seront comptés d'un coup comme consommation (plus ce que la borne consomme d'ici là). Une autre valeur reste retenue.`,
          ),
  },
};

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  disabled: both(
    'Commands are disabled: turn on "Allow the commands" in the configuration of the integration.',
    "Les commandes sont désactivées : activez « Autoriser les commandes » dans la configuration de l'intégration.",
  ),
  unknownCharger: both(
    'This charger is not read by the integration (address changed, another charger, or not answering).',
    "Cette borne n'est pas lue par l'intégration (adresse changée, autre borne, ou sans réponse).",
  ),
  badButton: both('A button only accepts the value 1.', "Un bouton n'accepte que la valeur 1."),
  badCurrent: both(
    'The charging current must be a whole number of amperes.',
    "Le courant de charge doit être un nombre entier d'ampères.",
  ),
  outOfBounds: (min, max) =>
    both(
      `The charging current must be between ${min} and ${max} A for this charger: not sent.`,
      `Le courant de charge doit être entre ${min} et ${max} A pour cette borne : non envoyé.`,
    ),
  paused: (wait) =>
    both(
      `The charger asked to slow down: commands paused for ${wait.en} ("Pause charging" stays available).`,
      `La borne a demandé de ralentir : commandes en pause pendant ${wait.fr} (« Mettre la charge en pause » reste disponible).`,
    ),
  noCredentials: both(
    'The charger refused the user name and password (new try later): not sent.',
    "La borne a refusé le nom d'utilisateur et le mot de passe (nouvel essai plus tard) : non envoyée.",
  ),
  oldFirmware: (version) =>
    both(
      `This command needs the WiFi firmware ${version} or later of OpenEVSE: not sent.`,
      `Cette commande demande le firmware WiFi ${version} ou plus récent d'OpenEVSE : non envoyée.`,
    ),
  stillRunning: both(
    'Another command of this charger is still running: not sent ("Pause charging" stays available).',
    'Une autre commande de cette borne est encore en cours : non envoyée (« Mettre la charge en pause » reste disponible).',
  ),
  pauseMeanwhile: both(
    'A pause of this charger arrived meanwhile: this command is not sent.',
    "Une pause de cette borne est arrivée entre-temps : cette commande n'est pas envoyée.",
  ),
  tooOften: (wait) =>
    both(
      `A start or a current change was sent less than a minute ago: try again in ${wait.en} ("Pause charging" stays available). Not sent.`,
      `Un démarrage ou un changement de courant a été envoyé il y a moins d'une minute : réessayez dans ${wait.fr} (« Mettre la charge en pause » reste disponible). Non envoyé.`,
    ),
  tooSlow: both(
    'The charger answered too slowly to send the command in time: not sent.',
    'La borne a répondu trop lentement pour envoyer la commande à temps : non envoyée.',
  ),
  unknownState: (reason) =>
    both(
      `The state of the charger could not be read just before (${reason}): command not sent.`,
      `L'état de la borne n'a pas pu être relu juste avant (${reason}) : commande non envoyée.`,
    ),
  missing: both(
    'The charger did not give the state this command needs: not sent.',
    "La borne n'a pas donné l'état dont cette commande a besoin : non envoyée.",
  ),
  noVehicle: both(
    'No vehicle is plugged in: charging is not started. Not sent.',
    "Aucun véhicule n'est branché : la charge n'est pas démarrée. Non envoyée.",
  ),
  fault: (state) =>
    both(
      `The charger reports "${state.en}": charging is not started. Not sent.`,
      `La borne signale « ${state.fr} » : la charge n'est pas démarrée. Non envoyée.`,
    ),
  notSent: (reason) =>
    both(
      `The charger could not be reached (${reason}): command not sent.`,
      `La borne n'a pas pu être jointe (${reason}) : commande non envoyée.`,
    ),
  refused: (reason) =>
    both(
      `The charger refused the command (${reason}).`,
      `La borne a refusé la commande (${reason}).`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the state of the charger in a few seconds.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez l'état de la borne dans quelques secondes.`,
    ),
};

/** The one-line summary of the charger: "OpenEVSE 7B2C: Charging, 7200 W, 32 A offered". */
export function summaryOf({ name, power, pilot }, stateText) {
  const en = [stateText.en];
  const fr = [stateText.fr];
  if (power !== undefined) {
    en.push(`${power} W`);
    fr.push(`${power} W`);
  }
  if (pilot !== undefined) {
    en.push(`${pilot} A offered`);
    fr.push(`${pilot} A proposés`);
  }
  return both(`${name}: ${en.join(', ')}.`, `${name} : ${fr.join(', ')}.`);
}
