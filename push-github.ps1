# Script pour push vers GitHub
cd "C:\Users\Admin\Documents\PLAY-MOVE-main\PLAY-MOVE-main"

# Initialiser git si nécessaire
if (-not (Test-Path .git)) {
    git init
}

# Configurer le remote
git remote remove origin 2>$null
git remote add origin https://github.com/MALICK-GITH/PLAY-MOVE.git

# Ajouter tous les fichiers
git add .

# Commit
git commit -m "feat: add internal proxy and Swagger documentation

- Add internal proxy configuration (localhost:8080)
- Integrate Swagger UI for API documentation
- Add OpenAPI 3.0 specification
- Add health check endpoint
- Update dependencies"

# Push vers GitHub
git push -u origin main