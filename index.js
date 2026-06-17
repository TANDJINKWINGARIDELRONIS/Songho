/**
 * Songo - Édition Prestige (Frontend Logic & Animation Engine)
 * Fichier : index.js
 */

/**
 * URL du point de terminaison de l'API PHP.
 * Utilisée pour toutes les requêtes de synchronisation de l'état du jeu et d'exécution des coups.
 */
const ENDPOINT_PHP = "index.php?api=1";

/**
 * Rôle attribué au joueur sur ce client/navigateur.
 * - 1 : Joueur Sud (gère les cases de 0 à 6)
 * - 2 : Joueur Nord (gère les cases de 7 à 13)
 * Sa valeur n'est définitive qu'après le passage par l'écran de sélection de camp.
 */
let roleJoueur = 1;

/**
 * Drapeau bloquant les requêtes de synchronisation et les clics
 * pendant qu'une animation de distribution (semis) ou de capture (rafle) est en cours.
 */
let isAnimating = false;

/**
 * Compteur local du dernier coup animé.
 * Permet de détecter si le serveur renvoie un nouvel état suite à un coup joué
 * par l'adversaire ou par soi-même afin de déclencher l'animation au bon moment.
 */
let dernierCoupCounter = 0;

/**
 * Drapeau indiquant si la page vient d'être chargée.
 * Empêche de rejouer l'animation du dernier coup enregistré dans le fichier JSON
 * lors du chargement initial de la page par un joueur.
 */
let estPremierChargement = true;

/**
 * Identifiants des minuteurs (setInterval) actifs, conservés pour pouvoir
 * les arrêter proprement lors d'un changement d'écran (sélection <-> partie).
 */
let pollIntervalId = null;
let pollStatutId = null;

/**
 * Clé utilisée pour mémoriser le camp choisi dans sessionStorage.
 * sessionStorage est propre à chaque onglet/fenêtre : deux joueurs sur deux
 * appareils différents (ou même deux onglets du même navigateur en test local)
 * conservent chacun leur propre rôle sans interférence.
 */
const CLE_ROLE = "songoRole";

// ==========================================================================
// 1. MODULE AUDIO NATIVE (window.kit)
// ==========================================================================

/**
 * Exposition de l'objet window.kit demandée par le cahier des charges.
 * Utilise l'API Web Audio native du navigateur pour synthétiser des sons
 * de percussions sèches (dépôt des graines) et des mélodies (capture).
 */
window.kit = {
    /**
     * Synthétise un son court et mat rappelant le bruit d'une graine de Songo
     * retombant dans une case en bois creusée.
     */
    playSeedSound: function () {
        try {
            // Initialisation du contexte audio (compatible avec les anciens navigateurs Webkit)
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(audioCtx.destination);

            // Type triangle pour un rendu plus doux et boisé qu'un bip sinusoïdal
            oscillator.type = 'triangle';

            // Fréquence qui descend très rapidement (glissando) pour imiter le choc physique
            oscillator.frequency.setValueAtTime(380, audioCtx.currentTime);
            oscillator.frequency.exponentialRampToValueAtTime(70, audioCtx.currentTime + 0.08);

            // Gestion de l'amplitude (volume de départ à 0.40 qui s'éteint en 80ms)
            gainNode.gain.setValueAtTime(0.40, audioCtx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.08);

            oscillator.start(audioCtx.currentTime);
            oscillator.stop(audioCtx.currentTime + 0.08);
        } catch (e) {
            console.warn("API Web Audio bloquée ou non supportée par le navigateur :", e);
        }
    },

    /**
     * Synthétise un arpège rapide et joyeux composé de trois notes successives
     * (Accord majeur de Do) pour marquer la capture réussie de graines.
     */
    playCaptureSound: function () {
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const now = audioCtx.currentTime;

            // Notes : Do (261Hz), Mi (329Hz), Sol (392Hz)
            const accordGraines = [261.63, 329.63, 392.00];

            accordGraines.forEach((frequence, index) => {
                const oscillator = audioCtx.createOscillator();
                const gainNode = audioCtx.createGain();

                oscillator.connect(gainNode);
                gainNode.connect(audioCtx.destination);

                oscillator.type = 'sine'; // Son pur sinusoïdal pour un effet de cloche
                oscillator.frequency.setValueAtTime(frequence, now + index * 0.07);

                // Chaque note démarre l'une après l'autre et s'estompe en 250ms
                gainNode.gain.setValueAtTime(0.25, now + index * 0.07);
                gainNode.gain.exponentialRampToValueAtTime(0.01, now + index * 0.07 + 0.25);

                oscillator.start(now + index * 0.07);
                oscillator.stop(now + index * 0.07 + 0.25);
            });
        } catch (e) {
            console.warn("Impossible de jouer le son de capture :", e);
        }
    }
};

// ==========================================================================
// 2. MOTEUR D'ANIMATION DE SEMIS PROGRESSIF (CASE PAR CASE)
// ==========================================================================

/**
 * Gère l'affichage séquentiel de la distribution des graines dans les cases adjacentes,
 * joue les sons, gère la surbrillance dorée et le clignotement rouge en cas de capture.
 * * @param {number} indexDepart - L'index physique de la case qui a démarré les semailles.
 * @param {number} nbGraines - Le nombre de graines qui étaient dans cette case.
 * @param {object} finalData - Les données finales du jeu après application du coup côté PHP.
 * @param {function} callback - Action finale à exécuter après la fin de l'animation.
 */
function animerSemailles(indexDepart, nbGraines, finalData, callback) {
    isAnimating = true;

    // Verrouillage de sécurité : on désactive immédiatement le clic sur toutes les cases
    const cases = document.querySelectorAll(".pit");
    cases.forEach(c => c.disabled = true);

    // Initialisation d'une structure locale temporaire de graines à partir de l'état actuel à l'écran
    let countsMap = {};
    cases.forEach(caseJeu => {
        let index = parseInt(caseJeu.getAttribute("index"), 10);
        let count = parseInt(caseJeu.querySelector(".seed-count").textContent, 10);
        countsMap[index] = count;
    });

    // Étape 1 : Vider visuellement la case sélectionnée de départ
    countsMap[indexDepart] = 0;
    const startingPit = document.querySelector(`.pit[index="${indexDepart}"]`);
    if (startingPit) {
        startingPit.querySelector(".seed-count").textContent = 0;
    }

    // Étape 2 : Calculer le chemin exact de distribution (sens anti-horaire, index décroissants)
    let chemin = [];
    let curr = indexDepart;
    for (let g = 0; g < nbGraines; g++) {
        curr = (curr - 1 + 14) % 14;
        if (curr === indexDepart) {
            // Règle du Songo : si on fait un tour complet, on saute la case de départ originelle
            curr = (curr - 1 + 14) % 14;
        }
        chemin.push(curr);
    }

    let etape = 0;

    /**
     * Fonction récursive cadencée qui distribue une graine à chaque appel.
     */
    function playNextStep() {
        // Supprime la surbrillance de l'étape précédente sur tout le plateau
        document.querySelectorAll(".pit").forEach(p => p.classList.remove("pit-distrib"));

        if (etape < chemin.length) {
            let targetIndex = chemin[etape];
            const pitDom = document.querySelector(`.pit[index="${targetIndex}"]`);

            if (pitDom) {
                // Application de la classe de surbrillance dorée définie en CSS
                pitDom.classList.add("pit-distrib");

                // Incrémentation locale de la valeur simulée
                countsMap[targetIndex]++;

                // Mise à jour de l'affichage textuel
                pitDom.querySelector(".seed-count").textContent = countsMap[targetIndex];

                // Lecture du son de dépôt
                window.kit.playSeedSound();
            }

            etape++;
            // Latence réglable entre chaque dépôt de graine (ici 450ms)
            setTimeout(playNextStep, 450);
        } else {
            // Toutes les graines sont semées. On passe à la détection et à l'animation des captures.
            setTimeout(animerCaptures, 400);
        }
    }

    /**
     * Analyse les différences entre la distribution simulée locale
     * et le résultat officiel du serveur pour détecter les captures (rafles).
     */
    function animerCaptures() {
        // Nettoyage de la surbrillance de distribution
        document.querySelectorAll(".pit").forEach(p => p.classList.remove("pit-distrib"));

        let casesCapturees = [];
        for (let i = 0; i < 14; i++) {
            // Si la case a reçu des graines pendant la distribution (simulée > 0)
            // mais qu'elle est vide dans l'état final du serveur (plateau === 0), c'est une capture !
            if (countsMap[i] > 0 && finalData.plateau[i] === 0) {
                casesCapturees.push(i);
            }
        }

        if (casesCapturees.length > 0) {
            // Lecture du son harmonieux de capture
            window.kit.playCaptureSound();

            // Illumination des cases capturées avec la classe rouge clignotante .pit-capture
            casesCapturees.forEach(idx => {
                const pitDom = document.querySelector(`.pit[index="${idx}"]`);
                if (pitDom) {
                    pitDom.classList.add("pit-capture");
                    pitDom.querySelector(".seed-count").textContent = 0;
                }
            });

            // Laisse clignoter les cases capturées pendant 900ms avant de terminer
            setTimeout(() => {
                document.querySelectorAll(".pit").forEach(p => p.classList.remove("pit-capture"));
                finaliser();
            }, 900);
        } else {
            finaliser();
        }
    }

    /**
     * Rétablit les drapeaux et appelle le callback de mise à jour finale
     */
    function finaliser() {
        isAnimating = false;
        callback();
    }

    // Lancement de la première étape de distribution
    playNextStep();
}

// ==========================================================================
// 3. RÉCUPÉRATION ET SYNCHRONISATION DE L'ÉTAT DU JEU (POLLING)
// ==========================================================================

/**
 * Effectue la requête GET vers le serveur pour obtenir l'état du jeu.
 * Gère la waiting room, filtre le rafraîchissement si une animation est en cours,
 * et déclenche l'animation des semailles si un nouveau coup adverse est détecté.
 */
function modifierTableauDeJeu() {
    // Si nous sommes en train d'animer les graines, on ignore temporairement le rafraîchissement
    if (isAnimating) return;

    // Envoi du rôle joueur dans l'URL (GET) pour maintenir le heartbeat actif côté PHP
    fetch(`${ENDPOINT_PHP}&joueur=${roleJoueur}`)
        .then(response => response.json())
        .then(data => {
            if (!data || !data.plateau) {
                if (data && data.message) {
                    document.querySelector(".message-log").textContent = data.message;
                }
                return;
            }

            // --- GESTION DE LA WAITING ROOM (ATTENTE MULTIJOUEUR) ---
            if (!data.ready) {
                document.querySelector(".message-log").textContent = "En attente de la connexion du deuxième joueur pour démarrer...";
                document.getElementById("turn-display").textContent = "ATTENTE DE L'ADVERSAIRE";

                // Verrouille l'intégralité des cases pour empêcher tout coup
                const cases = document.querySelectorAll(".pit");
                cases.forEach(caseJeu => {
                    caseJeu.classList.remove("case-active");
                    caseJeu.classList.add("case-verrouillee");
                    caseJeu.disabled = true;

                    // Affiche tout de même l'état actuel du tablier
                    let indexCase = parseInt(caseJeu.getAttribute("index"), 10);
                    caseJeu.querySelector(".seed-count").textContent = data.plateau[indexCase];
                });
                return;
            }

            // --- DÉTECTION D'UN NOUVEAU COUP SUR LE SERVEUR ---
            if (data.dernierCoup && data.dernierCoup.counter > dernierCoupCounter) {
                dernierCoupCounter = data.dernierCoup.counter;

                // Si c'est le tout premier chargement, on affiche juste sans animer
                if (estPremierChargement) {
                    estPremierChargement = false;
                    appliquerEtatJeu(data);
                } else {
                    // Lance l'animation de semis du coup reçu depuis le serveur
                    animerSemailles(
                        data.dernierCoup.index,
                        data.dernierCoup.nbGraines,
                        data,
                        () => appliquerEtatJeu(data)
                    );
                }
                return;
            }

            // Enregistre le compteur actuel si c'est le démarrage initial
            if (estPremierChargement) {
                if (data.dernierCoup) {
                    dernierCoupCounter = data.dernierCoup.counter;
                }
                estPremierChargement = false;
            }

            // Mise à jour visuelle classique directe
            appliquerEtatJeu(data);
        })
        .catch(error => console.error("Erreur critique avec le serveur PHP :", error));
}

/**
 * Applique l'état du jeu (graines, scores, tours) sur l'interface DOM
 * sans effectuer d'animation progressive.
 * * @param {object} data - Les données du jeu renvoyées par le serveur.
 */
function appliquerEtatJeu(data) {
    const cases = document.querySelectorAll(".pit");

    cases.forEach((caseJeu) => {
        let indexCase = parseInt(caseJeu.getAttribute("index"), 10);

        // Mise à jour de la valeur textuelle
        caseJeu.querySelector(".seed-count").textContent = data.plateau[indexCase];

        // Réinitialisation des classes CSS d'état
        caseJeu.classList.remove("case-active", "case-verrouillee");

        // Si la partie est terminée, on bloque tout
        if (data.statut === "Terminé") {
            caseJeu.classList.add("case-verrouillee");
            caseJeu.disabled = true;
            return;
        }

        // Vérification et activation des cases selon le tour de rôle
        if (data.tour === roleJoueur) {
            if (roleJoueur === 1 && indexCase >= 0 && indexCase <= 6 && data.plateau[indexCase] > 0) {
                caseJeu.classList.add("case-active");
                caseJeu.disabled = false;
            } else if (roleJoueur === 2 && indexCase >= 7 && indexCase <= 13 && data.plateau[indexCase] > 0) {
                caseJeu.classList.add("case-active");
                caseJeu.disabled = false;
            } else {
                caseJeu.classList.add("case-verrouillee");
                caseJeu.disabled = true;
            }
        } else {
            caseJeu.classList.add("case-verrouillee");
            caseJeu.disabled = true;
        }
    });

    // Mise à jour des scores globaux
    document.getElementById("score-sud").textContent = data.scoreJ1;
    document.getElementById("score-nord").textContent = data.scoreJ2;

    const affichageTour = document.getElementById("turn-display");

    if (data.statut === "Terminé") {
        let vainqueur = (data.scoreJ1 >= 40) ? "Joueur Sud" : "Joueur Nord";
        if (data.scoreJ1 === data.scoreJ2) vainqueur = "Égalité";
        affichageTour.textContent = "PARTIE TERMINÉE !";
        document.querySelector(".message-log").textContent = "Gagnant : " + vainqueur + ". Partie finie !";
    } else {
        if (data.tour === roleJoueur) {
            affichageTour.textContent = "C'EST À VOUS DE JOUER !";
            document.querySelector(".message-log").textContent = "Cliquez sur une case de votre rangée pour lancer les semailles.";
        } else {
            affichageTour.textContent = "ATTENTE DU COUP ADVERSE...";
            document.querySelector(".message-log").textContent = "L'adversaire réfléchit. Veuillez patienter.";
        }
    }
}

// ==========================================================================
// 4. ENVOI DU COUP AU SERVEUR (POST)
// ==========================================================================

/**
 * Envoie le coup joué par le joueur actif au serveur via POST.
 * Bloque l'exécution visuelle le temps de l'animation locale des graines.
 * * @param {number} indexSelec - L'index de la case jouée (0 à 13).
 */
function lancerSemailles(indexSelec) {
    if (isAnimating) return;
    isAnimating = true;

    const formData = new URLSearchParams();
    formData.append('index', indexSelec);
    formData.append('joueur', roleJoueur);

    fetch(ENDPOINT_PHP, {
        method: 'POST',
        body: formData
    })
        .then(response => response.json())
        .then(reponse => {
            if (reponse.success) {
                // Enregistre immédiatement le nouveau compteur pour éviter que le polling ne le rejoue
                dernierCoupCounter = reponse.dernierCoup.counter;

                // Démarre l'animation progressive côté client
                animerSemailles(
                    indexSelec,
                    reponse.dernierCoup.nbGraines,
                    reponse,
                    () => {
                        // Applique l'état final et affiche d'éventuels messages système
                        appliquerEtatJeu(reponse);
                        if (reponse.message) {
                            AlerteArbitrage(reponse.message);
                        }
                    }
                );
            } else {
                isAnimating = false;
                AlerteArbitrage(reponse.message);
                modifierTableauDeJeu();
            }
        })
        .catch(error => {
            isAnimating = false;
            console.error("Erreur de transmission du coup :", error);
            modifierTableauDeJeu();
        });
}

/**
 * Affiche une alerte d'arbitrage temporaire en couleur rouge sombre.
 * * @param {string} msg - Le message d'erreur ou d'arbitrage à afficher.
 */
function AlerteArbitrage(msg) {
    const messageLog = document.querySelector(".message-log");
    messageLog.textContent = msg;
    messageLog.style.color = "#b71c1c";

    setTimeout(function () {
        messageLog.style.color = "";
        modifierTableauDeJeu();
    }, 5000);
}

// ==========================================================================
// 5. ÉCRAN DE SÉLECTION DE CAMP (LOBBY NORD / SUD)
// ==========================================================================

/**
 * Interroge le serveur pour savoir quels camps sont actuellement occupés
 * (un joueur est considéré "actif" si son heartbeat date de moins de 6 secondes).
 * N'envoie volontairement AUCUN paramètre "joueur" : cette requête est une simple
 * consultation et ne doit jamais réserver un camp à la place du visiteur.
 */
function rafraichirStatutCamps() {
    fetch(ENDPOINT_PHP)
        .then(response => response.json())
        .then(data => {
            if (!data) return;
            const campsActifs = data.campsActifs || { "1": false, "2": false };
            majBoutonCamp("choix-sud", "statut-sud", !!campsActifs["1"]);
            majBoutonCamp("choix-nord", "statut-nord", !!campsActifs["2"]);
        })
        .catch(error => console.error("Statut des camps indisponible :", error));
}

/**
 * Met à jour visuellement un bouton de camp (disponible / déjà pris).
 */
function majBoutonCamp(idBouton, idStatut, estPris) {
    const bouton = document.getElementById(idBouton);
    const statut = document.getElementById(idStatut);
    if (!bouton || !statut) return;

    if (estPris) {
        statut.textContent = "Déjà pris";
        bouton.classList.add("camp-pris");
        bouton.disabled = true;
    } else {
        statut.textContent = "Disponible";
        bouton.classList.remove("camp-pris");
        bouton.disabled = false;
    }
}

/**
 * Affiche l'écran de sélection de camp et démarre le rafraîchissement
 * périodique de la disponibilité des deux camps.
 */
function entrerEcranSelection() {
    document.getElementById("app-container").classList.add("hidden");
    document.getElementById("selection-screen").classList.remove("hidden");
    document.getElementById("selection-message").textContent = "";

    rafraichirStatutCamps();
    if (pollStatutId) clearInterval(pollStatutId);
    pollStatutId = setInterval(rafraichirStatutCamps, 1500);
}

/**
 * Tente de réserver le camp choisi par le joueur. Une dernière vérification
 * est faite auprès du serveur juste avant de valider, pour limiter les
 * collisions si deux personnes cliquent au même moment.
 * * @param {number} camp - 1 pour Sud, 2 pour Nord.
 */
function tenterChoixCamp(camp) {
    fetch(ENDPOINT_PHP)
        .then(response => response.json())
        .then(data => {
            const campsActifs = (data && data.campsActifs) || { "1": false, "2": false };
            if (campsActifs[String(camp)]) {
                document.getElementById("selection-message").textContent =
                    "Ce camp vient d'être pris par quelqu'un d'autre, choisissez l'autre camp.";
                rafraichirStatutCamps();
                return;
            }

            roleJoueur = camp;
            sessionStorage.setItem(CLE_ROLE, String(camp));

            if (pollStatutId) {
                clearInterval(pollStatutId);
                pollStatutId = null;
            }

            demarrerPartie();
        })
        .catch(error => {
            console.error("Impossible de vérifier la disponibilité du camp :", error);
            document.getElementById("selection-message").textContent =
                "Connexion au serveur impossible, merci de réessayer.";
        });
}

/**
 * Affiche le plateau de jeu et lance toute la logique de partie
 * (polling régulier, gestion des clics, bouton de réinitialisation et de
 * changement de camp).
 */
function demarrerPartie() {
    document.getElementById("selection-screen").classList.add("hidden");
    document.getElementById("app-container").classList.remove("hidden");

    document.querySelector(".message-log").textContent =
        "Vous êtes le Joueur " + (roleJoueur === 1 ? "Sud" : "Nord") + ". Connexion au serveur...";

    estPremierChargement = true;

    // Lancer la première mise à jour immédiate
    modifierTableauDeJeu();

    // Polling régulier chaque seconde (1000ms) pour les heartbeats et coups adverses
    if (pollIntervalId) clearInterval(pollIntervalId);
    pollIntervalId = setInterval(modifierTableauDeJeu, 1000);
}

// ==========================================================================
// 6. INITIALISATION AU CHARGEMENT DU DOM
// ==========================================================================

document.addEventListener("DOMContentLoaded", () => {
    // Attache les gestionnaires de clic sur les deux cartes de camp (une seule fois)
    document.getElementById("choix-nord").addEventListener("click", () => tenterChoixCamp(2));
    document.getElementById("choix-sud").addEventListener("click", () => tenterChoixCamp(1));

    // Assignation des gestionnaires de clic sur les cases du plateau (une seule fois)
    const cases = document.querySelectorAll(".pit");
    cases.forEach(caseJeu => {
        caseJeu.addEventListener("click", function () {
            // Le clic n'est autorisé que si aucune animation n'est en cours
            // et que la case est marquée comme cliquable / active par le système
            if (!isAnimating && this.classList.contains("case-active")) {
                let indexCase = parseInt(this.getAttribute("index"), 10);
                lancerSemailles(indexCase);
            }
        });
    });

    // Gestion du bouton de réinitialisation
    const btnRecommencer = document.getElementById("btn-recommencer");
    if (btnRecommencer) {
        btnRecommencer.addEventListener("click", () => {
            if (isAnimating) return; // Sécurité anti-clic pendant animation

            // Transmission du rôle avec le reset pour maintenir la connexion active
            fetch(`index.php?reset=1&joueur=${roleJoueur}`)
                .then(response => response.json())
                .then(data => {
                    estPremierChargement = true;
                    dernierCoupCounter = 0;
                    modifierTableauDeJeu();
                    if (data.message) {
                        AlerteArbitrage(data.message);
                    }
                })
                .catch(error => console.error("Erreur de réinitialisation :", error));
        });
    }

    // Gestion du bouton de changement de camp : revient à l'écran de sélection
    // sans remettre la partie en cours à zéro (le tablier et les scores restent intacts).
    const btnQuitter = document.getElementById("btn-quitter-camp");
    if (btnQuitter) {
        btnQuitter.addEventListener("click", () => {
            if (isAnimating) return;

            if (pollIntervalId) {
                clearInterval(pollIntervalId);
                pollIntervalId = null;
            }
            sessionStorage.removeItem(CLE_ROLE);
            entrerEcranSelection();
        });
    }

    // Si un camp a déjà été choisi précédemment dans cet onglet (sessionStorage),
    // on rejoint directement la partie sans repasser par l'écran de sélection.
    const roleSauvegarde = sessionStorage.getItem(CLE_ROLE);
    if (roleSauvegarde === "1" || roleSauvegarde === "2") {
        roleJoueur = parseInt(roleSauvegarde, 10);
        demarrerPartie();
    } else {
        entrerEcranSelection();
    }
});
