# LLM Chatbot

Application web locale pour creer les comptes free tier des fournisseurs LLM, enregistrer leurs cles API, puis discuter avec un chatbot qui choisit automatiquement un modele disponible.

Ce projet s'appuie sur le depot open source [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi). Il en reutilise le routeur multi-fournisseurs, le stockage chiffre des cles API, les controles de sante et la chaine de fallback. L'usage vise ici est volontairement plus simple : tout se fait depuis l'interface web.

## Fonctionnement

1. Ouvrir l'application.
2. Aller sur l'ecran `Onboarding`.
3. Creer un compte free tier chez un ou plusieurs fournisseurs depuis les liens proposes.
4. Generer une cle API, puis la coller dans l'interface.
5. Lancer la verification des cles.
6. Ouvrir `Chatbot` et discuter.

Une seule cle suffit pour tester le chatbot. Ajouter plusieurs fournisseurs permet au routeur de basculer automatiquement si un modele est indisponible, rate limite, ou en erreur.

## Fournisseurs guides

L'ecran d'embarquement inclut des liens de creation de compte et de generation de cle pour :

- Google AI Studio / Gemini
- Groq
- Cerebras
- SambaNova
- NVIDIA NIM
- Mistral
- OpenRouter
- GitHub Models
- Cohere
- Cloudflare Workers AI
- Z.ai / Zhipu
- Ollama Cloud
- Kilo Gateway
- Pollinations
- LLM7

Pour Google Gemini, le lien de creation de cle pointe vers :

```text
https://aistudio.google.com/api-keys
```

## Lancer en local

Prerequis : Node.js 20+ et npm.

```powershell
npm.cmd install
npm.cmd run dev
```

Puis ouvrir :

```text
http://localhost:5173/onboarding
```

Sur Windows, `npm.cmd` evite les blocages PowerShell lies a `npm.ps1`.

## Configuration locale

Le serveur a besoin d'une cle de chiffrement pour stocker les cles API fournisseurs.

Si le fichier `.env` n'existe pas encore, creer :

```env
ENCRYPTION_KEY=remplacer-par-une-cle-hex-64-caracteres
PORT=3001
```

Pour generer une cle :

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Utiliser l'application

### Onboarding

La page `Onboarding` sert de procedure d'embarquement :

- ouvrir les pages de compte et de creation de cle des fournisseurs ;
- coller les cles API ;
- gerer les cas particuliers comme Cloudflare, qui demande `account id` + token ;
- activer les fournisseurs anonymes en laissant la valeur `anonymous` ;
- verifier que les cles sont utilisables ;
- acceder ensuite au chatbot.

### Chatbot

La page `Chatbot` envoie les messages au routeur local. Le routeur choisit le meilleur modele disponible selon les cles configurees, les limites connues et la chaine de fallback.

L'utilisateur n'a pas besoin d'appeler une API manuellement, d'utiliser `curl`, un SDK OpenAI, ou de manipuler du tool calling. Ces capacites restent dans le moteur technique herite de FreeLLMAPI, mais l'usage de ce projet passe par l'interface web.

### Fallback

La page `Fallback` permet de modifier l'ordre de priorite des modeles. Quand une requete echoue ou qu'un fournisseur est rate limite, le routeur essaye le modele suivant dans la chaine.

### Keys

La page `Keys` reste disponible pour administrer directement les cles :

- ajouter une cle ;
- supprimer une cle ;
- verifier une cle ;
- voir son etat.

### Analytics

La page `Analytics` affiche l'activite locale : volumes de requetes, latence, erreurs et repartition par fournisseur.

## Build production

```powershell
npm.cmd run build
node server/dist/index.js
```

En production, le serveur Express sert l'API locale et le client compile.

## Securite et limites

- Les cles fournisseurs sont chiffrees en SQLite avec AES-256-GCM.
- Le projet est pense pour un usage personnel ou experimental.
- Ne pas exposer l'application telle quelle sur Internet sans ajouter une vraie couche d'authentification.
- Les free tiers changent souvent : quotas, modeles disponibles, conditions d'utilisation et limites peuvent evoluer.
- Si une cle devient invalide ou rate limitee, la verification de sante et le fallback aident a continuer avec un autre fournisseur configure.

## Origine

Base technique : [tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi)

Cette version adapte le projet pour un parcours oriente interface :

- procedure d'embarquement pour creer les comptes free tier ;
- saisie guidee des cles API ;
- chatbot directement utilisable ;
- suppression du branding visible FreeLLMAPI dans l'interface.

## Licence

MIT, comme le projet d'origine.
