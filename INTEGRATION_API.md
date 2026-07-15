# Documentation d'Intégration API - PLAY-MOVE

## Vue d'ensemble

Ce service API Finder analyse les appels API (XHR/Fetch) effectués par une page web en utilisant un navigateur headless Playwright. Il fonctionne comme un moteur API pour des plateformes externes.

---

## Configuration du Serveur

### Variables d'Environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PORT` | 3000 | Port d'écoute du serveur |
| `PROXY_URL` | http://localhost:8080 | URL du proxy interne pour le trafic |

### Démarrage Local

```bash
npm install
npm start
```

Le serveur sera accessible sur `http://localhost:3000`

---

## Endpoints Disponibles

### 1. POST /analyze

**Description**: Analyse une page web et capture tous les appels API (XHR/Fetch).

**URL**: `POST /analyze`

**Rate Limiting**: 5 requêtes par minute par IP

**Corps de la Requête**:
```json
{
  "url": "https://example.com"
}
```

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| url | string | Oui | URL complète de la page à analyser (http:// ou https://) |

**Réponse Succès (200)**:
```json
{
  "source": "https://example.com",
  "count": 15,
  "requests": [
    {
      "method": "GET",
      "url": "https://api.example.com/data",
      "headers": {
        "content-type": "application/json",
        "authorization": "[REDACTED]"
      },
      "postData": null,
      "responsePreview": "{\"data\": [...]}",
      "status": 200
    }
  ]
}
```

**Réponses d'Erreur**:

| Code | Description | Corps |
|------|-------------|-------|
| 400 | URL manquante ou invalide | `{"error": "URL manquante ou invalide"}` |
| 400 | URL malformée | `{"error": "URL malformée"}` |
| 400 | Schéma non autorisé | `{"error": "Schéma non autorisé (seulement http/https)"}` |
| 400 | IP privée détectée | `{"error": "Cible non autorisée (IP privée ou loopback)"}` |
| 429 | Trop de requêtes | `{"error": "Trop de requêtes, réessaie dans une minute."}` |
| 500 | Erreur interne | `{"error": "Échec de l'analyse", "detail": "..."}` |

---

### 2. GET /health

**Description**: Vérifie si le service est opérationnel.

**URL**: `GET /health`

**Réponse (200)**:
```
API Finder Service — OK
```

---

### 3. GET /api-docs

**Description**: Interface Swagger UI pour la documentation interactive.

**URL**: `GET /api-docs`

Redirige vers la documentation Swagger UI.

---

### 4. GET /

**Description**: Redirection vers la documentation API.

**URL**: `GET /`

Redirige vers `/api-docs`.

---

## Sécurité et Restrictions

### Anti-SSRF (Server-Side Request Forgery)

Le service bloque les requêtes vers:
- IPs privées (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
- Loopback (127.0.0.0/8, ::1)
- Link-local (169.254.0.0/16, fe80::/10)
- IPv6 privées (fc00::/7, fd00::/8)

### Sanitisation des Données

- **Headers sensibles**: `authorization`, `cookie`, `set-cookie`, `proxy-authorization` sont masqués avec `[REDACTED]`
- **Limites de taille**: Corps des requêtes limité à 2000 caractères, preview de réponse à 500 caractères
- **Maximum de capture**: 200 requêtes maximum par analyse

### CORS

Le CORS est activé pour tous les origins.

---

## Intégration Externe

### Exemple cURL

```bash
curl -X POST http://localhost:3000/analyze \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

### Exemple JavaScript (Fetch)

```javascript
const response = await fetch('http://localhost:3000/analyze', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    url: 'https://example.com'
  })
});

const data = await response.json();
console.log(data);
```

### Exemple Python (Requests)

```python
import requests

response = requests.post(
    'http://localhost:3000/analyze',
    json={'url': 'https://example.com'}
)

data = response.json()
print(data)
```

---

## Configuration Proxy Interne

Le service utilise un proxy interne pour le trafic du navigateur:

- **URL par défaut**: `http://localhost:8080`
- **Configuration**: Définie dans `server.js` ligne 22
- **Utilisation**: Toutes les requêtes du navigateur Playwright passent par ce proxy

Pour modifier le proxy, éditez la ligne 22 de `server.js`:

```javascript
const PROXY_URL = 'http://votre-proxy:port';
```

---

## Déploiement

### Render (Production)

Le service est configuré pour Render avec `render.yaml`.

URL de production: `https://play-move-1.onrender.com`

### Docker

Un `Dockerfile` est disponible pour le déploiement containerisé.

```bash
docker build -t api-finder .
docker run -p 3000:3000 api-finder
```

---

## Dépendances

- express: 4.19.2
- playwright: 1.61.1
- cors: 2.8.5
- express-rate-limit: 7.4.0
- swagger-ui-express: ^5.0.0
- yamljs: ^0.3.0

---

## Dépannage

### Erreur "Un scan est déjà en cours"

Le service traite une seule analyse à la fois. Attendez quelques secondes avant de réessayer.

### Erreur "Trop de requêtes"

Respectez la limite de 5 requêtes par minute.

### Erreur "Cible non autorisée"

L'URL cible résout vers une IP privée ou loopback. Utilisez uniquement des URLs publiques.

### Timeout Global

L'analyse a un timeout global de 30 secondes. Si une page est trop lente, l'analyse sera interrompue.

---

## Support

Pour toute question d'intégration, consultez la documentation Swagger interactive sur `/api-docs` ou contactez le support technique.
