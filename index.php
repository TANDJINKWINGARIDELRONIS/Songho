<?php
/**
 * Songo - Édition Prestige (Backend Multi-joueurs)
 * Fichier : api.php
 */

if ($_SERVER['REQUEST_METHOD'] === 'GET' && !isset($_GET['api']) && !isset($_GET['reset'])) {
    header("Content-Type: text/html; charset=UTF-8");
    readfile(__DIR__ . "/index.html");
    exit;
}

header("Content-Type: application/json; charset=UTF-8");
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: GET, POST");
header("Access-Control-Allow-Headers: Content-Type");

$fichier_jeu = __DIR__ . "/etat_jeu.json";

/**
 * Génère la structure de données initiale d'une nouvelle partie.
 */
function genererNouvellePartie() {
    return [
        "plateau" => array_fill(0, 14, 5),
        "scoreJ1" => 0,
        "scoreJ2" => 0,
        "tour"    => 1,
        "statut"  => "En cours",
        "derniereActivite" => [
            "1" => 0,
            "2" => 0
        ],
        "dernierCoup" => [
            "joueur" => 0,
            "index" => -1,
            "nbGraines" => 0,
            "counter" => 0
        ],
        // Demande de réinitialisation soumise à l'accord des DEUX joueurs.
        "resetRequest" => [
            "actif" => false,          // Une demande est-elle en cours ?
            "demandeur" => 0,          // Qui a initié la demande (1 ou 2)
            "reponses" => [            // Réponse de chaque joueur : null = pas répondu, true = accepté
                "1" => null,
                "2" => null
            ],
            "counter" => 0,            // Incrémenté à chaque nouvelle demande (notification client)
            "statutMessage" => "",     // Message affiché une fois la demande résolue
            "statutCounter" => 0       // Incrémenté à chaque résolution (acceptée ou refusée)
        ]
    ];
}

$fp = fopen($fichier_jeu, "c+");
if (!$fp) {
    echo json_encode(["success" => false, "message" => "Erreur critique : Impossible d'accéder au fichier de jeu."]);
    exit;
}

flock($fp, LOCK_EX);

$taille = filesize($fichier_jeu);
$contenu = $taille > 0 ? fread($fp, $taille) : "";
$gameState = json_decode($contenu, true);

if (!$gameState) {
    $gameState = genererNouvellePartie();
}

// Compatibilité : si une ancienne partie sauvegardée n'a pas encore le champ resetRequest
if (!isset($gameState['resetRequest'])) {
    $gameState['resetRequest'] = [
        "actif" => false,
        "demandeur" => 0,
        "reponses" => ["1" => null, "2" => null],
        "counter" => 0,
        "statutMessage" => "",
        "statutCounter" => 0
    ];
}

// --------------------------------------------------------------------------
// SYNCHRONISATION / HEARTBEAT
// --------------------------------------------------------------------------
$idJoueurActif = -1;
if ($_SERVER['REQUEST_METHOD'] === 'GET' && isset($_GET['joueur'])) {
    $idJoueurActif = intval($_GET['joueur']);
} elseif ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['joueur'])) {
    $idJoueurActif = intval($_POST['joueur']);
}

if ($idJoueurActif === 1 || $idJoueurActif === 2) {
    if (!isset($gameState['derniereActivite'])) {
        $gameState['derniereActivite'] = [
            "1" => 0,
            "2" => 0
        ];
    }
    $gameState['derniereActivite'][$idJoueurActif] = time();
}

$tempsActuel = time();
$j1_actif = isset($gameState['derniereActivite'][1]) && ($tempsActuel - intval($gameState['derniereActivite'][1]) < 6);
$j2_actif = isset($gameState['derniereActivite'][2]) && ($tempsActuel - intval($gameState['derniereActivite'][2]) < 6);
$ready = $j1_actif && $j2_actif;
$gameState['ready'] = $ready;

$gameState['campsActifs'] = [
    "1" => $j1_actif,
    "2" => $j2_actif
];

// --------------------------------------------------------------------------
// ROUTES D'ACTIONS POST : demande_reset / repondre_reset
// --------------------------------------------------------------------------
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action'])) {
    $action = $_POST['action'];
    $idJoueur = isset($_POST['joueur']) ? intval($_POST['joueur']) : -1;

    if ($idJoueur !== 1 && $idJoueur !== 2) {
        flock($fp, LOCK_UN);
        fclose($fp);
        echo json_encode(["success" => false, "message" => "Joueur invalide."]);
        exit;
    }

    if ($action === 'demande_reset') {
        // On lance (ou relance) une demande de réinitialisation.
        // Le demandeur est considéré comme ayant automatiquement accepté.
        $gameState['resetRequest']['actif'] = true;
        $gameState['resetRequest']['demandeur'] = $idJoueur;
        $gameState['resetRequest']['reponses'] = ["1" => null, "2" => null];
        $gameState['resetRequest']['reponses'][(string)$idJoueur] = true;
        $gameState['resetRequest']['counter'] = ($gameState['resetRequest']['counter'] ?? 0) + 1;

        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, json_encode($gameState));
        fflush($fp);
        flock($fp, LOCK_UN);
        fclose($fp);

        echo json_encode(array_merge(["success" => true], $gameState));
        exit;
    }

    if ($action === 'repondre_reset') {
        $reponse = isset($_POST['reponse']) ? $_POST['reponse'] : '';

        // Si aucune demande n'est active, on renvoie simplement l'état actuel
        if (!$gameState['resetRequest']['actif']) {
            flock($fp, LOCK_UN);
            fclose($fp);
            echo json_encode(array_merge(["success" => true], $gameState));
            exit;
        }

        if ($reponse === 'refuser') {
            // Un seul refus suffit à annuler la demande : la partie continue normalement.
            $gameState['resetRequest']['actif'] = false;
            $gameState['resetRequest']['reponses'] = ["1" => null, "2" => null];
            $gameState['resetRequest']['statutMessage'] =
                "La demande de réinitialisation a été refusée. La partie continue.";
            $gameState['resetRequest']['statutCounter'] = ($gameState['resetRequest']['statutCounter'] ?? 0) + 1;
        } elseif ($reponse === 'accepter') {
            $gameState['resetRequest']['reponses'][(string)$idJoueur] = true;

            $j1ok = ($gameState['resetRequest']['reponses']['1'] === true);
            $j2ok = ($gameState['resetRequest']['reponses']['2'] === true);

            if ($j1ok && $j2ok) {
                // Les deux joueurs ont accepté : on réinitialise réellement le tablier.
                $anciennesActivites = $gameState['derniereActivite'] ?? ["1" => 0, "2" => 0];
                $ancienCompteurStatut = $gameState['resetRequest']['statutCounter'] ?? 0;

                $nouvelEtat = genererNouvellePartie();
                $nouvelEtat['derniereActivite'] = $anciennesActivites;
                $nouvelEtat['resetRequest']['statutMessage'] =
                    "Les deux joueurs ont accepté. Le tablier a été réinitialisé.";
                $nouvelEtat['resetRequest']['statutCounter'] = $ancienCompteurStatut + 1;

                $gameState = $nouvelEtat;
            }
        }

        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, json_encode($gameState));
        fflush($fp);
        flock($fp, LOCK_UN);
        fclose($fp);

        echo json_encode(array_merge(["success" => true], $gameState));
        exit;
    }
}

// --------------------------------------------------------------------------
// ROUTE D'INTERROGATION (GET) : Appelée en boucle par le client (Polling)
// --------------------------------------------------------------------------
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($gameState));
    fflush($fp);

    flock($fp, LOCK_UN);
    fclose($fp);
    echo json_encode($gameState);
    exit;
}

// --------------------------------------------------------------------------
// ROUTE DE TRAITEMENT DU COUP (POST)
// --------------------------------------------------------------------------
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!$ready) {
        flock($fp, LOCK_UN);
        fclose($fp);
        echo json_encode(["success" => false, "message" => "Attente de l'adversaire pour commencer à jouer !"]);
        exit;
    }

    $indexCase = isset($_POST['index']) ? intval($_POST['index']) : -1;
    $idJoueur  = isset($_POST['joueur']) ? intval($_POST['joueur']) : -1;

    if ($idJoueur !== $gameState['tour']) {
        flock($fp, LOCK_UN);
        fclose($fp);
        echo json_encode(["success" => false, "message" => "Interdit : Ce n'est pas votre tour de jouer ! En attente de l'adversaire."]);
        exit;
    }

    if ($indexCase < 0 || $indexCase > 13) {
        flock($fp, LOCK_UN);
        fclose($fp);
        echo json_encode(["success" => false, "message" => "Erreur : Case inexistante."]);
        exit;
    }

    if ($idJoueur === 1 && ($indexCase < 0 || $indexCase > 6)) {
        flock($fp, LOCK_UN);
        fclose($fp);
        echo json_encode(["success" => false, "message" => "Faute : Vous êtes le Joueur SUD, jouez dans votre camp !"]);
        exit;
    }
    if ($idJoueur === 2 && ($indexCase < 7 || $indexCase > 13)) {
        flock($fp, LOCK_UN);
        fclose($fp);
        echo json_encode(["success" => false, "message" => "Faute : Vous êtes le Joueur NORD, jouez dans votre camp !"]);
        exit;
    }

    $grainesA_Semer = $gameState['plateau'][$indexCase];
    if ($grainesA_Semer === 0) {
        flock($fp, LOCK_UN);
        fclose($fp);
        echo json_encode(["success" => false, "message" => "Impossible : Cette case ne contient aucune graine !"]);
        exit;
    }

    // RÈGLE DE SOLIDARITÉ (Anti-famine préventive)
    $campAdverseVide = true;
    $debutAdversaire = ($idJoueur === 1) ? 7 : 0;
    $finAdversaire   = ($idJoueur === 1) ? 13 : 6;

    for ($k = $debutAdversaire; $k <= $finAdversaire; $k++) {
        if ($gameState['plateau'][$k] > 0) {
            $campAdverseVide = false;
            break;
        }
    }

    if ($campAdverseVide) {
        $indexSimule = $indexCase;
        $grainesSimulees = $grainesA_Semer;
        $nourritAdversaire = false;

        while ($grainesSimulees > 0) {
            $indexSimule = ($indexSimule - 1 + 14) % 14;
            if ($indexSimule === $indexCase) continue;
            if ($indexSimule >= $debutAdversaire && $indexSimule <= $finAdversaire) {
                $nourritAdversaire = true;
            }
            $grainesSimulees--;
        }

        if (!$nourritAdversaire) {
            $unCoupNourricierExiste = false;
            $debutMonCamp = ($idJoueur === 1) ? 0 : 7;
            $finMonCamp   = ($idJoueur === 1) ? 6 : 13;

            for ($c = $debutMonCamp; $c <= $finMonCamp; $c++) {
                $gMonCamp = $gameState['plateau'][$c];
                if ($gMonCamp > 0) {
                    $idxS = $c;
                    while ($gMonCamp > 0) {
                         $idxS = ($idxS - 1 + 14) % 14;
                         if ($idxS === $c) continue;
                         if ($idxS >= $debutAdversaire && $idxS <= $finAdversaire) {
                             $unCoupNourricierExiste = true;
                             break 2;
                         }
                         $gMonCamp--;
                    }
                }
            }

            if ($unCoupNourricierExiste) {
                flock($fp, LOCK_UN);
                fclose($fp);
                echo json_encode(["success" => false, "message" => "Règle de Solidarité : Vous devez impérativement nourrir votre adversaire affamé !"]);
                exit;
            }
        }
    }

    // SEMAILLES HORAIRES (Décrémentation des index)
    $nbGrainesOriginal = $grainesA_Semer;
    $gameState['plateau'][$indexCase] = 0;
    $currentIndex = $indexCase;

    while ($grainesA_Semer > 0) {
        $currentIndex = ($currentIndex - 1 + 14) % 14;
        if ($currentIndex === $indexCase) continue;

        $gameState['plateau'][$currentIndex]++;
        $grainesA_Semer--;
    }

    // CAPTURE ET RAFLE
    $cibleAdverse = false;
    if ($idJoueur === 1 && $currentIndex >= 7 && $currentIndex <= 13) $cibleAdverse = true;
    if ($idJoueur === 2 && $currentIndex >= 0 && $currentIndex <= 6) $cibleAdverse = true;

    $gainPotentiel = 0;
    $casesA_Vider = [];
    $indexRafle = $currentIndex;
    $rafleAdverse = $cibleAdverse;

    while ($rafleAdverse && $gameState['plateau'][$indexRafle] >= 2 && $gameState['plateau'][$indexRafle] <= 4) {
        if ($idJoueur === 1 && $indexRafle === 13) break;
        if ($idJoueur === 2 && $indexRafle === 6) break;

        $gainPotentiel += $gameState['plateau'][$indexRafle];
        $casesA_Vider[] = $indexRafle;

        $indexRafle = ($indexRafle + 1) % 14;
        $rafleAdverse = ($idJoueur === 1 && $indexRafle >= 7 && $indexRafle <= 13) ||
                        ($idJoueur === 2 && $indexRafle >= 0 && $indexRafle <= 6);
    }

    $grainesRestantesCampAdverse = 0;
    for ($i = $debutAdversaire; $i <= $finAdversaire; $i++) {
        $grainesRestantesCampAdverse += $gameState['plateau'][$i];
    }

    if ($gainPotentiel > 0 && $gainPotentiel === $grainesRestantesCampAdverse) {
        $gameState['tour'] = ($idJoueur === 1) ? 2 : 1;

        $gameState['dernierCoup'] = [
            "joueur" => $idJoueur,
            "index" => $indexCase,
            "nbGraines" => $nbGrainesOriginal,
            "counter" => ($gameState['dernierCoup']['counter'] ?? 0) + 1
        ];

        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, json_encode($gameState));
        fflush($fp);
        flock($fp, LOCK_UN);
        fclose($fp);

        echo json_encode(array_merge([
            "success" => true,
            "message" => "Interdit appliqué : Rafle annulée ! Il est interdit de piller la totalité des graines."
        ], $gameState));
        exit;
    }

    if (!empty($casesA_Vider)) {
        foreach ($casesA_Vider as $indexPrise) {
            if ($idJoueur === 1) {
                $gameState['scoreJ1'] += $gameState['plateau'][$indexPrise];
            } else {
                $gameState['scoreJ2'] += $gameState['plateau'][$indexPrise];
            }
            $gameState['plateau'][$indexPrise] = 0;
        }
    }

    if ($gameState['scoreJ1'] >= 40 || $gameState['scoreJ2'] >= 40) {
        $gameState['statut'] = "Terminé";
    }

    $gameState['tour'] = ($idJoueur === 1) ? 2 : 1;

    $gameState['dernierCoup'] = [
        "joueur" => $idJoueur,
        "index" => $indexCase,
        "nbGraines" => $nbGrainesOriginal,
        "counter" => ($gameState['dernierCoup']['counter'] ?? 0) + 1
    ];

    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($gameState));
    fflush($fp);

    flock($fp, LOCK_UN);
    fclose($fp);

    echo json_encode(array_merge(["success" => true], $gameState));
    exit;
}
?>