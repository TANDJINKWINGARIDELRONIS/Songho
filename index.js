/**
 * Songo - Édition Prestige (Frontend Logic & Animation Engine)
 * Fichier : index.js
 */

const ENDPOINT_PHP = "index.php?api=1";

let roleJoueur = 1;
let isAnimating = false;
let dernierCoupCounter = 0;
let estPremierChargement = true;
let pollIntervalId = null;
let pollStatutId = null;
const CLE_ROLE = "songoRole";

// Suivi local de la demande de réinitialisation (notification croisée)
let resetRequestCounterAffiche = 0;
let resetRequestStatutAffiche = 0;
let modalResetOuvert = false;

// ==========================================================================
// 1. MODULE AUDIO NATIVE (window.kit)
// ==========================================================================

window.kit = {
    playSeedSound: function () {
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(audioCtx.destination);

            oscillator.type = 'triangle';
            oscillator.frequency.setValueAtTime(380, audioCtx.currentTime);
            oscillator.frequency.exponentialRampToValueAtTime(70, audioCtx.currentTime + 0.08);

            gainNode.gain.setValueAtTime(0.40, audioCtx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.08);

            oscillator.start(audioCtx.currentTime);
            oscillator.stop(audioCtx.currentTime + 0.08);
        } catch (e) {
            console.warn("API Web Audio bloquée ou non supportée par le navigateur :", e);
        }
    },

    playCaptureSound: function () {
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const now = audioCtx.currentTime;
            const accordGraines = [261.63, 329.63, 392.00];

            accordGraines.forEach((frequence, index) => {
                const oscillator = audioCtx.createOscillator();
                const gainNode = audioCtx.createGain();

                oscillator.connect(gainNode);
                gainNode.connect(audioCtx.destination);

                oscillator.type = 'sine';
                oscillator.frequency.setValueAtTime(frequence, now + index * 0.07);

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

function animerSemailles(indexDepart, nbGraines, finalData, callback) {
    isAnimating = true;

    const cases = document.querySelectorAll(".pit");
    cases.forEach(c => c.disabled = true);

    let countsMap = {};
    cases.forEach(caseJeu => {
        let index = parseInt(caseJeu.getAttribute("index"), 10);
        let count = parseInt(caseJeu.querySelector(".seed-count").textContent, 10);
        countsMap[index] = count;
    });

    countsMap[indexDepart] = 0;
    const startingPit = document.querySelector(`.pit[index="${indexDepart}"]`);
    if (startingPit) {
        startingPit.querySelector(".seed-count").textContent = 0;
    }

    let chemin = [];
    let curr = indexDepart;
    for (let g = 0; g < nbGraines; g++) {
        curr = (curr - 1 + 14) % 14;
        if (curr === indexDepart) {
            curr = (curr - 1 + 14) % 14;
        }
        chemin.push(curr);
    }

    let etape = 0;

    function playNextStep() {
        document.querySelectorAll(".pit").forEach(p => p.classList.remove("pit-distrib"));

        if (etape < chemin.length) {
            let targetIndex = chemin[etape];
            const pitDom = document.querySelector(`.pit[index="${targetIndex}"]`);

            if (pitDom) {
                pitDom.classList.add("pit-distrib");
                countsMap[targetIndex]++;
                pitDom.querySelector(".seed-count").textContent = countsMap[targetIndex];
                window.kit.playSeedSound();
            }

            etape++;
            setTimeout(playNextStep, 450);
        } else {
            setTimeout(animerCaptures, 400);
        }
    }

    function animerCaptures() {
        document.querySelectorAll(".pit").forEach(p => p.classList.remove("pit-distrib"));

        let casesCapturees = [];
        for (let i = 0; i < 14; i++) {
            if (countsMap[i] > 0 && finalData.plateau[i] === 0) {
                casesCapturees.push(i);
            }
        }

        if (casesCapturees.length > 0) {
            window.kit.playCaptureSound();

            casesCapturees.forEach(idx => {
                const pitDom = document.querySelector(`.pit[index="${idx}"]`);
                if (pitDom) {
                    pitDom.classList.add("pit-capture");
                    pitDom.querySelector(".seed-count").textContent = 0;
                }
            });

            setTimeout(() => {
                document.querySelectorAll(".pit").forEach(p => p.classList.remove("pit-capture"));
                finaliser();
            }, 900);
        } else {
            finaliser();
        }
    }

    function finaliser() {
        isAnimating = false;
        callback();
    }

    playNextStep();
}

// ==========================================================================
// 3. RÉCUPÉRATION ET SYNCHRONISATION DE L'ÉTAT DU JEU (POLLING)
// ==========================================================================

function modifierTableauDeJeu() {
    if (isAnimating) return;

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

                const cases = document.querySelectorAll(".pit");
                cases.forEach(caseJeu => {
                    caseJeu.classList.remove("case-active");
                    caseJeu.classList.add("case-verrouillee");
                    caseJeu.disabled = true;

                    let indexCase = parseInt(caseJeu.getAttribute("index"), 10);
                    caseJeu.querySelector(".seed-count").textContent = data.plateau[indexCase];
                });
                return;
            }

            // --- GESTION DE LA DEMANDE DE RÉINITIALISATION (NOTIFICATION CROISÉE) ---
            gererResetRequest(data.resetRequest);

            // --- DÉTECTION D'UN NOUVEAU COUP SUR LE SERVEUR ---
            if (data.dernierCoup && data.dernierCoup.counter > dernierCoupCounter) {
                dernierCoupCounter = data.dernierCoup.counter;

                if (estPremierChargement) {
                    estPremierChargement = false;
                    appliquerEtatJeu(data);
                } else {
                    animerSemailles(
                        data.dernierCoup.index,
                        data.dernierCoup.nbGraines,
                        data,
                        () => appliquerEtatJeu(data)
                    );
                }
                return;
            }

            if (estPremierChargement) {
                if (data.dernierCoup) {
                    dernierCoupCounter = data.dernierCoup.counter;
                }
                estPremierChargement = false;
            }

            appliquerEtatJeu(data);
        })
        .catch(error => console.error("Erreur critique avec le serveur PHP :", error));
}

function appliquerEtatJeu(data) {
    const cases = document.querySelectorAll(".pit");

    cases.forEach((caseJeu) => {
        let indexCase = parseInt(caseJeu.getAttribute("index"), 10);

        caseJeu.querySelector(".seed-count").textContent = data.plateau[indexCase];
        caseJeu.classList.remove("case-active", "case-verrouillee");

        if (data.statut === "Terminé") {
            caseJeu.classList.add("case-verrouillee");
            caseJeu.disabled = true;
            return;
        }

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
                dernierCoupCounter = reponse.dernierCoup.counter;

                animerSemailles(
                    indexSelec,
                    reponse.dernierCoup.nbGraines,
                    reponse,
                    () => {
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
// 4bis. DEMANDE DE RÉINITIALISATION AVEC ACCORD MUTUEL
// ==========================================================================

/**
 * Analyse l'objet resetRequest renvoyé par le serveur et déclenche
 * l'affichage de la modale appropriée (demande à accepter/refuser,
 * écran d'attente, ou message de résolution).
 */
function gererResetRequest(resetRequest) {
    if (!resetRequest) {
        masquerModalReset();
        return;
    }

    // Une demande vient d'être résolue (acceptée par les deux, ou refusée)
    if (resetRequest.statutCounter && resetRequest.statutCounter !== resetRequestStatutAffiche) {
        resetRequestStatutAffiche = resetRequest.statutCounter;
        masquerModalReset();
        if (resetRequest.statutMessage) {
            AlerteArbitrage(resetRequest.statutMessage);
        }
        return;
    }

    if (resetRequest.actif) {
        const maReponse = resetRequest.reponses ? resetRequest.reponses[String(roleJoueur)] : null;

        if (maReponse === null || maReponse === undefined) {
            // Ce joueur n'a pas encore répondu : on lui montre la demande
            if (resetRequest.counter !== resetRequestCounterAffiche) {
                resetRequestCounterAffiche = resetRequest.counter;
                afficherModalReset(resetRequest.demandeur);
            }
        } else {
            // Ce joueur (le demandeur) attend la réponse de l'autre
            afficherAttenteReset();
        }
    } else {
        masquerModalReset();
    }
}

function creerModalResetSiAbsent() {
    if (document.getElementById("reset-modal-overlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "reset-modal-overlay";
    overlay.style.cssText = "display:none;position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;align-items:center;justify-content:center;";

    const carte = document.createElement("div");
    carte.id = "reset-modal-carte";
    carte.style.cssText = "background:#fffdf5;color:#3a2a1a;border-radius:14px;padding:28px 32px;max-width:380px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,0.35);font-family:inherit;";

    const titre = document.createElement("h2");
    titre.style.cssText = "margin:0 0 12px;font-size:1.2rem;";
    titre.textContent = "Réinitialisation du tablier";

    const message = document.createElement("p");
    message.id = "reset-modal-message";
    message.style.cssText = "margin:0 0 20px;font-size:0.95rem;line-height:1.4;";

    const actions = document.createElement("div");
    actions.id = "reset-modal-actions";
    actions.style.cssText = "display:flex;gap:12px;justify-content:center;";

    const btnAccepter = document.createElement("button");
    btnAccepter.textContent = "Accepter";
    btnAccepter.style.cssText = "padding:10px 18px;border:none;border-radius:8px;background:#2e7d32;color:#fff;font-weight:600;cursor:pointer;";
    btnAccepter.addEventListener("click", () => repondreReset("accepter"));

    const btnRefuser = document.createElement("button");
    btnRefuser.textContent = "Refuser";
    btnRefuser.style.cssText = "padding:10px 18px;border:none;border-radius:8px;background:#b71c1c;color:#fff;font-weight:600;cursor:pointer;";
    btnRefuser.addEventListener("click", () => repondreReset("refuser"));

    actions.appendChild(btnAccepter);
    actions.appendChild(btnRefuser);

    carte.appendChild(titre);
    carte.appendChild(message);
    carte.appendChild(actions);
    overlay.appendChild(carte);
    document.body.appendChild(overlay);
}

function afficherModalReset(demandeurId) {
    creerModalResetSiAbsent();
    const overlay = document.getElementById("reset-modal-overlay");
    const message = document.getElementById("reset-modal-message");
    const actions = document.getElementById("reset-modal-actions");

    const nomDemandeur = (demandeurId === 1) ? "Sud" : "Nord";
    message.textContent = "Le Joueur " + nomDemandeur + " souhaite réinitialiser le tablier. Acceptez-vous ?";
    actions.style.display = "flex";
    overlay.style.display = "flex";
    modalResetOuvert = true;
}

function afficherAttenteReset() {
    creerModalResetSiAbsent();
    const overlay = document.getElementById("reset-modal-overlay");
    const message = document.getElementById("reset-modal-message");
    const actions = document.getElementById("reset-modal-actions");

    message.textContent = "En attente de la réponse de votre adversaire pour réinitialiser le tablier...";
    actions.style.display = "none";
    overlay.style.display = "flex";
    modalResetOuvert = true;
}

function masquerModalReset() {
    const overlay = document.getElementById("reset-modal-overlay");
    if (overlay) overlay.style.display = "none";
    modalResetOuvert = false;
}

function envoyerDemandeReset() {
    const formData = new URLSearchParams();
    formData.append("action", "demande_reset");
    formData.append("joueur", roleJoueur);

    fetch(ENDPOINT_PHP, { method: "POST", body: formData })
        .then(response => response.json())
        .then(() => modifierTableauDeJeu())
        .catch(error => console.error("Erreur lors de la demande de réinitialisation :", error));
}

function repondreReset(reponse) {
    const formData = new URLSearchParams();
    formData.append("action", "repondre_reset");
    formData.append("joueur", roleJoueur);
    formData.append("reponse", reponse);

    fetch(ENDPOINT_PHP, { method: "POST", body: formData })
        .then(response => response.json())
        .then(() => {
            masquerModalReset();
            modifierTableauDeJeu();
        })
        .catch(error => console.error("Erreur lors de la réponse à la réinitialisation :", error));
}

// ==========================================================================
// 5. ÉCRAN DE SÉLECTION DE CAMP (LOBBY NORD / SUD)
// ==========================================================================

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

function entrerEcranSelection() {
    document.getElementById("app-container").classList.add("hidden");
    document.getElementById("selection-screen").classList.remove("hidden");
    document.getElementById("selection-message").textContent = "";

    rafraichirStatutCamps();
    if (pollStatutId) clearInterval(pollStatutId);
    pollStatutId = setInterval(rafraichirStatutCamps, 1500);
}

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

function demarrerPartie() {
    document.getElementById("selection-screen").classList.add("hidden");
    document.getElementById("app-container").classList.remove("hidden");

    document.querySelector(".message-log").textContent =
        "Vous êtes le Joueur " + (roleJoueur === 1 ? "Sud" : "Nord") + ". Connexion au serveur...";

    estPremierChargement = true;

    modifierTableauDeJeu();

    if (pollIntervalId) clearInterval(pollIntervalId);
    pollIntervalId = setInterval(modifierTableauDeJeu, 1000);
}

// ==========================================================================
// 6. INITIALISATION AU CHARGEMENT DU DOM
// ==========================================================================

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("choix-nord").addEventListener("click", () => tenterChoixCamp(2));
    document.getElementById("choix-sud").addEventListener("click", () => tenterChoixCamp(1));

    const cases = document.querySelectorAll(".pit");
    cases.forEach(caseJeu => {
        caseJeu.addEventListener("click", function () {
            if (!isAnimating && this.classList.contains("case-active")) {
                let indexCase = parseInt(this.getAttribute("index"), 10);
                lancerSemailles(indexCase);
            }
        });
    });

    // Le bouton de réinitialisation déclenche maintenant une DEMANDE soumise
    // à l'accord des deux joueurs, au lieu de réinitialiser immédiatement.
    const btnRecommencer = document.getElementById("btn-recommencer");
    if (btnRecommencer) {
        btnRecommencer.addEventListener("click", () => {
            if (isAnimating) return;
            envoyerDemandeReset();
        });
    }

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

    const roleSauvegarde = sessionStorage.getItem(CLE_ROLE);
    if (roleSauvegarde === "1" || roleSauvegarde === "2") {
        roleJoueur = parseInt(roleSauvegarde, 10);
        demarrerPartie();
    } else {
        entrerEcranSelection();
    }
});