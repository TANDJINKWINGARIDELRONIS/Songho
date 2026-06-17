<?php
/**
 * Songo - Édition Prestige (Backend Multi-joueurs)
 * Fichier : api.php
 */

// Si la requête est un GET standard sans paramètre d'API ou de reset, on sert la page d'accueil HTML
if ($_SERVER['REQUEST_METHOD'] === 'GET' && !isset($_GET['api']) && !isset($_GET['reset'])) {
    header("Content-Type: text/html; charset=UTF-8");
    readfile(__DIR__ . "/index.html");
    exit;
}

header("Content-Type: application/json; charset=UTF-8");
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: GET, POST");
header("Access-Control-Allow-Headers: Content-Type");

// Emplacement du fichier de persistance partagé sur le serveur htdocs
$fichier_jeu = __DIR__ . "/etat_jeu.json";

/**
 * Génère la structure de données initiale d'une nouvelle partie.
 * Ajoute le suivi d'activité des joueurs et les détails du dernier coup.
 */
function genererNouvellePartie() {
    return [
        "plateau" => array_fill(0, 14, 5), // 14 cases garnies de 5 graines
        "scoreJ1" => 0,                    // Score Sud (Joueur 1)
        "scoreJ2" => 0,                    // Score Nord (Joueur 2)
        "tour"    => 1,                    // 1 = Sud, 2 = Nord
        "statut"  => "En cours",
        "derniereActivite" => [
            "1" => 0,                      // Horodatage de l'activité du Joueur 1
            "2" => 0                       // Horodatage de l'activité du Joueur 2
        ],
        "dernierCoup" => [
            "joueur" => 0,                 // Qui a joué le dernier coup
            "index" => -1,                 // Case cliquée
            "nbGraines" => 0,              // Nombre de graines semées
            "counter" => 0                 // Compteur incrémentiel unique pour l'animation
        ]
    ];
}

// --------------------------------------------------------------------------
// OPTIMISATION : Ouverture sécurisée avec verrouillage exclusif (Anti-corruption)
// --------------------------------------------------------------------------
// "c+" ouvre le fichier en lecture/écriture sans le vider, et le crée s'il n'existe pas.
$fp = fopen($fichier_jeu, "c+");
if (!$fp) {
    echo json_encode(["success" => false, "message" => "Erreur critique : Impossible d'accéder au fichier de jeu."]);
    exit;
}

// On demande un verrou exclusif (bloque les autres requêtes le temps du traitement)
flock($fp, LOCK_EX);

// Lecture du contenu actuel du fichier
$taille = filesize($fichier_jeu);
$contenu = $taille > 0 ? fread($fp, $taille) : "";
$gameState = json_decode($contenu, true);

// Initialisation si le fichier est vide ou corrompu
if (!$gameState) {
    $gameState = genererNouvellePartie();
}

// --------------------------------------------------------------------------
// SYNCHRONISATION / HEARTBEAT : Mise à jour de l'activité du joueur
// --------------------------------------------------------------------------
// idJoueurActif reste à -1 (donc aucune réservation de camp) tant que le client
// n'envoie pas explicitement son rôle. L'écran de sélection de camp s'appuie
// justement sur ce comportement pour interroger l'occupation sans rien réserver.
$idJoueurActif = -1;
if ($_SERVER['REQUEST_METHOD'] === 'GET' && isset($_GET['joueur'])) {
    $idJoueurActif = intval($_GET['joueur']);
} elseif ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['joueur'])) {
    $idJoueurActif = intval($_POST['joueur']);
}

// Si la requête provient d'un joueur valide, on met à jour son horodatage de présence
if ($idJoueurActif === 1 || $idJoueurActif === 2) {
    if (!isset($gameState['derniereActivite'])) {
        $gameState['derniereActivite'] = [
            "1" => 0,
            "2" => 0
        ];
    }
    $gameState['derniereActivite'][$idJoueurActif] = time();
}

// On vérifie si les deux joueurs sont connectés (activité récente < 6 secondes)
$tempsActuel = time();
$j1_actif = isset($gameState['derniereActivite'][1]) && ($tempsActuel - intval($gameState['derniereActivite'][1]) < 6);
$j2_actif = isset($gameState['derniereActivite'][2]) && ($tempsActuel - intval($gameState['derniereActivite'][2]) < 6);
$ready = $j1_actif && $j2_actif;
$gameState['ready'] = $ready;

// Statut individuel de chaque camp (utilisé par l'écran de sélection Nord/Sud
// pour afficher "Disponible" ou "Déjà pris" en temps réel).
$gameState['campsActifs'] = [
    "1" => $j1_actif,
    "2" => $j2_actif
];

// --------------------------------------------------------------------------
// ROUTE DE RÉINITIALISATION (RESET)
// --------------------------------------------------------------------------
if (isset($_GET['reset'])) {
    // On conserve les présences des joueurs pour éviter de casser la connexion
    $anciennesActivites = $gameState['derniereActivite'] ?? [
        "1" => 0,
        "2" => 0
    ];
    $gameState = genererNouvellePartie();
    $gameState['derniereActivite'] = $anciennesActivites;
    $gameState['ready'] = $ready; // Conserver l'état de préparation
    $gameState['campsActifs'] = [
        "1" => $j1_actif,
        "2" => $j2_actif
    ];

    // Sauvegarde immédiate
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($gameState));
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);

    echo json_encode(array_merge(["success" => true, "message" => "Le tablier a été réinitialisé."], $gameState));
    exit;
}

// --------------------------------------------------------------------------
// ROUTE D'INTERROGATION (GET) : Appelée en boucle par le client (Polling)
// --------------------------------------------------------------------------
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    // Sauvegarde de l'état (nécessaire pour persister le heartbeat mis à jour via GET)
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
    // 1. Contrôle de présence : Les deux joueurs doivent être connectés
    if (!$ready) {
        flock($fp, LOCK_UN);
        fclose($fp);
        echo json_encode(["success" => false, "message" => "Attente de l'adversaire pour commencer à jouer !"]);
        exit;
    }

    // Sécurisation et typage strict des entrées reçues du JS FormData
    $indexCase = isset($_POST['index']) ? intval($_POST['index']) : -1;
    $idJoueur  = isset($_POST['joueur']) ? intval($_POST['joueur']) : -1;

    // 2. Contrôle du tour de rôle global
    if ($idJoueur !== $gameState['tour']) {
        flock($fp, LOCK_UN);
        fclose($fp);
        echo json_encode(["success" => false, "message" => "Interdit : Ce n'est pas votre tour de jouer ! En attente de l'adversaire."]);
        exit;
    }

    // 3. Validation des index physiques du plateau
    if ($indexCase < 0 || $indexCase > 13) {
        flock($fp, LOCK_UN);
        fclose($fp);
        echo json_encode(["success" => false, "message" => "Erreur : Case inexistante."]);
        exit;
    }

    // 4. Règles territoriales strictes
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

    // 5. Présence de matière première
    $grainesA_Semer = $gameState['plateau'][$indexCase];
    if ($grainesA_Semer === 0) {
        flock($fp, LOCK_UN);
        fclose($fp);
        echo json_encode(["success" => false, "message" => "Impossible : Cette case ne contient aucune graine !"]);
        exit;
    }

    // 6. APPLICATION DE LA RÈGLE DE SOLIDARITÉ (Anti-famine préventive)
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

    // 7. LOGIQUE DES SEMAILLES HORAIRES (Décrémentation des index)
    $nbGrainesOriginal = $grainesA_Semer; // Sauvegarde pour l'animation
    $gameState['plateau'][$indexCase] = 0; 
    $currentIndex = $indexCase;

    while ($grainesA_Semer > 0) {
        $currentIndex = ($currentIndex - 1 + 14) % 14; 
        if ($currentIndex === $indexCase) continue; // Saut de la case d'origine
        
        $gameState['plateau'][$currentIndex]++;
        $grainesA_Semer--;
    }

    // 8. CAPTURE ET RAFLE (Analyse rétrograde : Sens anti-horaire)
    $cibleAdverse = false;
    if ($idJoueur === 1 && $currentIndex >= 7 && $currentIndex <= 13) $cibleAdverse = true;
    if ($idJoueur === 2 && $currentIndex >= 0 && $currentIndex <= 6) $cibleAdverse = true;

    $gainPotentiel = 0;
    $casesA_Vider = [];
    $indexRafle = $currentIndex;
    $rafleAdverse = $cibleAdverse;

    while ($rafleAdverse && $gameState['plateau'][$indexRafle] >= 2 && $gameState['plateau'][$indexRafle] <= 4) {
        // CORRECTION DU BUG D'ARBITRAGE :
        // Le Joueur 1 (Sud) ne peut pas capturer dans la PREMIÈRE case adverse (Nord, index 13, étiquetée case 1).
        // Le Joueur 2 (Nord) ne peut pas capturer dans la PREMIÈRE case adverse (Sud, index 6, étiquetée case 1).
        if ($idJoueur === 1 && $indexRafle === 13) break; 
        if ($idJoueur === 2 && $indexRafle === 6) break;

        $gainPotentiel += $gameState['plateau'][$indexRafle];
        $casesA_Vider[] = $indexRafle;

        $indexRafle = ($indexRafle + 1) % 14; 
        $rafleAdverse = ($idJoueur === 1 && $indexRafle >= 7 && $indexRafle <= 13) || 
                        ($idJoueur === 2 && $indexRafle >= 0 && $indexRafle <= 6);
    }

    // Validation de l'interdit suprême : Anti-famine totale suite à capture
    $grainesRestantesCampAdverse = 0;
    for ($i = $debutAdversaire; $i <= $finAdversaire; $i++) {
        $grainesRestantesCampAdverse += $gameState['plateau'][$i];
    }

    // Si la capture pille la totalité du camp adverse
    if ($gainPotentiel > 0 && $gainPotentiel === $grainesRestantesCampAdverse) {
        // La rafle est annulée, mais le coup reste joué et le tour passe à l'adversaire
        $gameState['tour'] = ($idJoueur === 1) ? 2 : 1;
        
        // Enregistrement du dernier coup pour déclencher l'animation chez les clients
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

    // Encaissement définitif des points validés
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

    // Fin de partie comptable (Seuil des 40 graines capturées)
    if ($gameState['scoreJ1'] >= 40 || $gameState['scoreJ2'] >= 40) {
        $gameState['statut'] = "Terminé";
    }

    // Changement de tour de rôle
    $gameState['tour'] = ($idJoueur === 1) ? 2 : 1;

    // Enregistrement du dernier coup pour déclencher l'animation chez les clients
    $gameState['dernierCoup'] = [
        "joueur" => $idJoueur,
        "index" => $indexCase,
        "nbGraines" => $nbGrainesOriginal,
        "counter" => ($gameState['dernierCoup']['counter'] ?? 0) + 1
    ];

    // Sauvegarde définitive des données calculées sur le serveur
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($gameState));
    fflush($fp);
    
    // Libération du verrou et fermeture du pointeur
    flock($fp, LOCK_UN);
    fclose($fp);

    echo json_encode(array_merge(["success" => true], $gameState));
    exit;
}
?>
