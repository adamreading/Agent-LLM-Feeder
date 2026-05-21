# LLM Chatbot

Local web app for onboarding free-tier LLM providers, saving API keys, and chatting through an automatic multi-provider fallback router.

Languages: [English](#english) | [Francais](#francais) | [Espanol](#espanol)

---

## English

LLM Chatbot is a local web application that helps you create free-tier accounts with LLM providers, store their API keys, and chat with a model selected automatically by the router.

This project is based on the open-source [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) repository. It reuses its multi-provider router, encrypted API-key storage, health checks, and fallback chain. This version focuses on a simpler workflow: everything is done from the web interface.

### How It Works

1. Open the app.
2. Go to `Onboarding`.
3. Create one or more free-tier provider accounts from the suggested links.
4. Generate an API key and paste it into the interface.
5. Run the key check.
6. Open `Chatbot` and start chatting.

One valid key is enough to test the chatbot. Adding several providers lets the router switch automatically when a model is unavailable, rate-limited, or failing.

### Guided Providers

The onboarding screen includes account and API-key links for:

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

For Google Gemini, the API-key page is:

```text
https://aistudio.google.com/api-keys
```

### Run Locally

Requirements: Node.js 20+ and npm.

```powershell
npm.cmd install
npm.cmd run dev
```

Then open:

```text
http://localhost:5173/onboarding
```

On Windows, `npm.cmd` avoids PowerShell execution-policy issues with `npm.ps1`.

### Local Configuration

The server needs an encryption key to store provider API keys.

If `.env` does not exist yet, create it:

```env
ENCRYPTION_KEY=replace-with-a-64-character-hex-key
PORT=3001
```

Generate a key with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Using The App

`Onboarding` is the guided setup flow: open provider signup pages, paste API keys, handle Cloudflare `account id` + token, enable anonymous providers with `anonymous`, check keys, then move to the chatbot.

`Chatbot` sends messages to the local router. The router picks the best available model based on configured keys, known limits, and fallback order.

You do not need to manually call an API, use `curl`, use an OpenAI SDK, or configure tool calling. Those technical capabilities remain in the FreeLLMAPI-based engine, but this project is meant to be used through the web interface.

`Fallback` lets you edit the model priority order. When a request fails or a provider is rate-limited, the router tries the next model.

`Keys` lets you directly manage provider keys: add, remove, verify, and inspect status.

`Analytics` shows local activity: request volume, latency, errors, and provider distribution.

### Production Build

```powershell
npm.cmd run build
node server/dist/index.js
```

In production, the Express server serves both the local API and the compiled client.

### Security And Limits

- Provider keys are encrypted in SQLite with AES-256-GCM.
- This project is intended for personal or experimental use.
- Do not expose the app to the Internet without adding real authentication.
- Free tiers change often: quotas, available models, terms, and limits may evolve.
- If a key becomes invalid or rate-limited, health checks and fallback help continue with another configured provider.

### Origin

Technical base: [tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi)

This version adapts the project for an interface-first workflow:

- guided free-tier account onboarding;
- guided API-key entry;
- directly usable chatbot;
- no visible FreeLLMAPI branding in the interface.

### License

MIT, same as the original project.

---

## Francais

LLM Chatbot est une application web locale pour creer des comptes free tier chez des fournisseurs LLM, enregistrer leurs cles API, puis discuter avec un modele choisi automatiquement par le routeur.

Ce projet s'appuie sur le depot open source [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi). Il en reutilise le routeur multi-fournisseurs, le stockage chiffre des cles API, les controles de sante et la chaine de fallback. Cette version vise un parcours plus simple : tout se fait depuis l'interface web.

### Fonctionnement

1. Ouvrir l'application.
2. Aller sur `Onboarding`.
3. Creer un compte free tier chez un ou plusieurs fournisseurs depuis les liens proposes.
4. Generer une cle API, puis la coller dans l'interface.
5. Lancer la verification des cles.
6. Ouvrir `Chatbot` et discuter.

Une seule cle suffit pour tester le chatbot. Ajouter plusieurs fournisseurs permet au routeur de basculer automatiquement si un modele est indisponible, rate limite, ou en erreur.

### Fournisseurs Guides

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

### Lancer En Local

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

### Configuration Locale

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

### Utiliser L'application

`Onboarding` sert de procedure guidee : ouvrir les pages de compte, coller les cles API, gerer Cloudflare avec `account id` + token, activer les fournisseurs anonymes avec `anonymous`, verifier les cles, puis passer au chatbot.

`Chatbot` envoie les messages au routeur local. Le routeur choisit le meilleur modele disponible selon les cles configurees, les limites connues et la chaine de fallback.

L'utilisateur n'a pas besoin d'appeler une API manuellement, d'utiliser `curl`, un SDK OpenAI, ou de manipuler du tool calling. Ces capacites restent dans le moteur technique herite de FreeLLMAPI, mais ce projet s'utilise depuis l'interface web.

`Fallback` permet de modifier l'ordre de priorite des modeles. Quand une requete echoue ou qu'un fournisseur est rate limite, le routeur essaye le modele suivant.

`Keys` permet d'administrer directement les cles : ajouter, supprimer, verifier et consulter l'etat.

`Analytics` affiche l'activite locale : volumes de requetes, latence, erreurs et repartition par fournisseur.

### Build Production

```powershell
npm.cmd run build
node server/dist/index.js
```

En production, le serveur Express sert l'API locale et le client compile.

### Securite Et Limites

- Les cles fournisseurs sont chiffrees en SQLite avec AES-256-GCM.
- Le projet est pense pour un usage personnel ou experimental.
- Ne pas exposer l'application sur Internet sans ajouter une vraie couche d'authentification.
- Les free tiers changent souvent : quotas, modeles disponibles, conditions et limites peuvent evoluer.
- Si une cle devient invalide ou rate limitee, la verification de sante et le fallback aident a continuer avec un autre fournisseur configure.

### Origine

Base technique : [tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi)

Cette version adapte le projet pour un parcours oriente interface :

- procedure d'embarquement pour creer les comptes free tier ;
- saisie guidee des cles API ;
- chatbot directement utilisable ;
- suppression du branding visible FreeLLMAPI dans l'interface.

### Licence

MIT, comme le projet d'origine.

---

## Espanol

LLM Chatbot es una aplicacion web local para crear cuentas free tier con proveedores LLM, guardar sus claves API y conversar con un modelo elegido automaticamente por el router.

Este proyecto se basa en el repositorio open source [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi). Reutiliza su router multi-proveedor, el almacenamiento cifrado de claves API, los chequeos de salud y la cadena de fallback. Esta version se centra en un flujo mas simple: todo se hace desde la interfaz web.

### Como Funciona

1. Abrir la aplicacion.
2. Ir a `Onboarding`.
3. Crear una o varias cuentas free tier desde los enlaces propuestos.
4. Generar una clave API y pegarla en la interfaz.
5. Ejecutar la verificacion de claves.
6. Abrir `Chatbot` y empezar a conversar.

Una sola clave valida basta para probar el chatbot. Agregar varios proveedores permite que el router cambie automaticamente si un modelo no esta disponible, esta limitado por cuota, o falla.

### Proveedores Guiados

La pantalla de onboarding incluye enlaces para crear cuenta y generar clave API en:

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

Para Google Gemini, la pagina de claves API es:

```text
https://aistudio.google.com/api-keys
```

### Ejecutar En Local

Requisitos: Node.js 20+ y npm.

```powershell
npm.cmd install
npm.cmd run dev
```

Luego abrir:

```text
http://localhost:5173/onboarding
```

En Windows, `npm.cmd` evita problemas de politicas de ejecucion de PowerShell con `npm.ps1`.

### Configuracion Local

El servidor necesita una clave de cifrado para almacenar las claves API de los proveedores.

Si el archivo `.env` todavia no existe, crearlo:

```env
ENCRYPTION_KEY=reemplazar-por-una-clave-hex-de-64-caracteres
PORT=3001
```

Para generar una clave:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Usar La Aplicacion

`Onboarding` es el flujo guiado: abrir paginas de registro, pegar claves API, manejar Cloudflare con `account id` + token, activar proveedores anonimos con `anonymous`, verificar claves y pasar al chatbot.

`Chatbot` envia los mensajes al router local. El router elige el mejor modelo disponible segun las claves configuradas, los limites conocidos y el orden de fallback.

El usuario no necesita llamar una API manualmente, usar `curl`, usar un SDK de OpenAI ni configurar tool calling. Esas capacidades tecnicas siguen existiendo en el motor basado en FreeLLMAPI, pero este proyecto esta pensado para usarse desde la interfaz web.

`Fallback` permite modificar el orden de prioridad de los modelos. Cuando una peticion falla o un proveedor esta limitado por cuota, el router intenta con el siguiente modelo.

`Keys` permite administrar directamente las claves: agregar, eliminar, verificar y consultar su estado.

`Analytics` muestra la actividad local: volumen de peticiones, latencia, errores y distribucion por proveedor.

### Build De Produccion

```powershell
npm.cmd run build
node server/dist/index.js
```

En produccion, el servidor Express sirve la API local y el cliente compilado.

### Seguridad Y Limites

- Las claves de proveedores se cifran en SQLite con AES-256-GCM.
- El proyecto esta pensado para uso personal o experimental.
- No expongas la aplicacion en Internet sin agregar una autenticacion real.
- Los free tiers cambian a menudo: cuotas, modelos disponibles, condiciones y limites pueden evolucionar.
- Si una clave se vuelve invalida o queda limitada, los chequeos de salud y el fallback ayudan a continuar con otro proveedor configurado.

### Origen

Base tecnica: [tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi)

Esta version adapta el proyecto a un flujo centrado en la interfaz:

- onboarding guiado para crear cuentas free tier;
- entrada guiada de claves API;
- chatbot listo para usar;
- sin branding visible FreeLLMAPI en la interfaz.

### Licencia

MIT, igual que el proyecto original.
