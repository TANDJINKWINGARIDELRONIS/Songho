# Songo - Édition Prestige

## Ce qui a changé

1. **Écran de choix de camp.** Le `prompt()` JavaScript a disparu. À l'arrivée sur la page, chaque joueur voit un petit lobby avec deux cartes « Nord » et « Sud ». Chaque carte affiche en direct si le camp est **Disponible** ou **Déjà pris** (rafraîchi toutes les 1,5 s via le serveur). Cliquer sur un camp libre rejoint la partie ; cliquer sur un camp pris est impossible (bouton désactivé).
2. **Mémorisation du rôle.** Le rôle choisi est gardé en `sessionStorage` (propre à l'onglet), donc un rafraîchissement de page ne redemande pas le camp. Un bouton **« Changer de camp »** a été ajouté près du bouton « Réinitialiser » pour revenir au lobby sans toucher au tablier ni aux scores.
3. **Backend.** `index.php` expose maintenant `campsActifs: {"1": bool, "2": bool}` dans toutes ses réponses, calculé à partir du heartbeat déjà existant (un camp est « actif » si une requête a été reçue pour ce rôle il y a moins de 6 secondes). Aucune logique de jeu n'a été modifiée.
4. **Déploiement.** Ajout d'un `Dockerfile`, d'un `.dockerignore`, d'un `.gitignore` et d'un `render.yaml` pour héberger le tout sur [Render](https://render.com).

## Limite connue

La vérification de disponibilité d'un camp est une convention de courtoisie, pas un verrou strict côté serveur : si deux personnes cliquent sur le même camp à la fraction de seconde près, rien n'empêche les deux requêtes de passer. Pour un usage entre amis/famille, ce n'est pas un problème en pratique.

## Déployer sur Render

Render n'a pas de runtime PHP natif (il faut Docker — c'est ce que fournit le `Dockerfile` inclus).

1. Crée un dépôt GitHub avec tous ces fichiers (`index.html`, `index.php`, `index.js`, `style.css`, `Dockerfile`, `.dockerignore`, `.gitignore`, `render.yaml`).
2. Sur [render.com](https://render.com), clique **New +** → **Web Service**, connecte ton dépôt GitHub.
3. Render détecte le `Dockerfile` automatiquement (sinon choisis **Docker** comme environnement).
4. Choisis le plan **Free** pour tester (suffisant pour jouer entre deux personnes).
5. Clique **Create Web Service**. Le premier build prend 1 à 2 minutes.
6. Une fois en ligne, tu obtiens une URL du type `https://songo-prestige.onrender.com`. **Envoie ce même lien aux deux joueurs** : chacun l'ouvre dans son propre navigateur et choisit son camp.

### À savoir sur le plan gratuit

- Le service **s'endort après 15 minutes d'inactivité** ; la requête suivante le réveille mais prend 30 à 60 secondes le temps du redémarrage.
- Le système de fichiers est **éphémère** : `etat_jeu.json` (qui contient la partie en cours) est remis à zéro à chaque redémarrage, redéploiement ou réveil après mise en veille. Concrètement, si la partie est interrompue plus de 15 minutes, le tablier repart à zéro au prochain coup. Pour une partie continue, restez actifs (le polling toutes les secondes empêche normalement la mise en veille tant que l'onglet reste ouvert).
- Si tu veux une persistance garantie même après redémarrage, il faudrait passer à un plan payant et attacher un **disque persistant** (`Persistent Disk` dans les réglages Render), monté par exemple sur `/app/data`, en adaptant le chemin de `$fichier_jeu` dans `index.php`. Ce n'est pas nécessaire pour jouer une partie classique entre deux personnes.

## Tester en local avant de déployer

```bash
php -S localhost:8000
```

Puis ouvre `http://localhost:8000` dans deux onglets différents (ou deux navigateurs) pour simuler les deux joueurs : `sessionStorage` étant propre à chaque onglet, chacun pourra choisir un camp différent.
