# Keou Cyber — démarrage en français

Cette édition cybersécurité / hacker / IA reprend la fluidité du template animé validé : titres vert phosphore, fond noir, police monospace, fenêtres de terminal, code qui se tape et curseur animé. Les signaux et réseaux restent en mouvement, avec voix synchronisée et sous-titres. Les exemples sont dans `examples/`.

## Ce qu'il te faut

Un Mac ou Linux (Windows via WSL2), Python 3.11+, SSH, rsync, ton compte Vast et un assistant capable de lire/écrire les fichiers et lancer des commandes. Une simple conversation web sans accès à ton ordinateur ne peut pas piloter le moteur.

1. Ouvre tout ce dossier dans Claude Code, Codex, OpenCode ou ton agent local.
2. Donne-lui `agent-prompts/START-HERE.md`, puis ton sujet ou ton script. Demande-lui de lire `AGENTS.md`.
3. Installe le contrôleur : `bash scripts/setup-host.sh`, puis `source .venv-controller/bin/activate`.
4. Configure ton accès : `python scripts/configure-vast.py`. La clé API est saisie sans être affichée.
5. Vérifie : `python kit.py doctor --vast`.
6. Crée un brouillon : `python kit.py new ma-video`.
7. L'agent adapte le script, le découpage et les illustrations, puis marque le projet `ready`.
8. Lance `python keou.py check projects/ma-video/project.json`, puis `python keou.py run projects/ma-video/project.json --budget 1 --minutes 60` dans le budget que tu autorises.

Le dernier ordre crée une instance payante sur ton compte. Le moteur rapatrie les résultats, vérifie leurs empreintes puis supprime sa propre instance. Garde ton ordinateur éveillé et connecté pendant la production. Un arrêt en erreur laisse éventuellement du stockage payant : lis `docs/VAST.md` et reprends le même job.

## Ce que tu récupères

`projects/ma-video/out/master.mp4`, un aperçu léger, les sous-titres SRT, le rapport qualité et les métadonnées YouTube. Les raccourcis `DERNIERE-VIDEO.mp4` et `APERCU.mp4` pointent vers la dernière livraison vérifiée.

Aucune publication ni planification automatique n'est activée. Le choix du sujet et la préparation des scènes restent le travail éditorial de ton agent. Le moteur vérifie la qualité technique ; il ne garantit pas les vues ou la rétention.

Pour conserver le style, demande de modifier le contenu du projet et les assets, pas le moteur. Consulte `docs/STYLE.md` pour les principes visuels et `docs/TROUBLESHOOTING.md` en cas d'erreur.

Commence par le film `examples/cyber-voice-scam/sample/master.mp4`. Le guide `docs/CYBER-STYLE.md` explique comment changer le sujet, les lignes de code, les trois labels et les animations sans refaire le moteur. Le kit produit des vidéos : les schémas ne sont pas des outils de détection ou de piratage.
