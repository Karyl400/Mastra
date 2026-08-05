# ==========================================
# Dockerfile for Kisso Onboarding (Mastra)
# ==========================================

# Étape 1 : Build
FROM node:22-slim AS builder

# Installe les dépendances nécessaires pour la compilation native (ex: better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copie des fichiers de package
COPY package.json package-lock.json ./

# Installation complète (inclut devDependencies pour le build TypeScript)
RUN npm ci

# Copie du reste du code source
COPY . .

# Génération des assets (Mastra build, TypeScript, Drizzle)
RUN npm run build:prod || (npx tsc && npx mastra build)

# Étape 2 : Production
FROM node:22-slim AS runner

WORKDIR /app

# Installe sqlite3 et les outils de base
RUN apt-get update && apt-get install -y sqlite3 && rm -rf /var/lib/apt/lists/*

# Définition de l'environnement de production
ENV NODE_ENV=production
ENV PORT=4111
ENV DATABASE_PATH=/app/data/kisso.db
ENV DB_WAL=true

# Création du dossier pour la base de données SQLite et persistance (pour montage volume)
RUN mkdir -p /app/data && chown -R node:node /app/data

# Copie des packages
COPY package.json package-lock.json ./

# Installation stricte des dépendances de prod
RUN npm ci --omit=dev

# Copie des fichiers buildés depuis le builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/.mastra ./.mastra
COPY --from=builder /app/mastra.config.ts ./mastra.config.ts

# L'utilisateur node pour la sécurité (non root)
USER node

# Exposition du port
EXPOSE 4111

# Commande de démarrage par défaut (via mastra dev ou start selon la stratégie)
CMD ["npm", "run", "start:prod"]
