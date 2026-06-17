# Render n'a pas de runtime PHP natif : on passe donc par Docker.
# php:cli + serveur intégré suffisent largement pour cette petite application
# (pas de framework, pas de dépendances Composer).
FROM php:8.3-cli

WORKDIR /app
COPY . /app

# Render fournit le port d'écoute attendu via la variable d'environnement PORT
# (10000 par défaut si jamais elle n'était pas transmise).
EXPOSE 10000

CMD ["sh", "-c", "php -S 0.0.0.0:${PORT:-10000} -t /app"]
