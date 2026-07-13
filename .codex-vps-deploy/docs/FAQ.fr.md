# Chama — Aide & FAQ

Bienvenue sur Chama — une place de marché où vous échangez avec votre communauté grâce au Bitcoin,
**sans avoir besoin de comprendre le Bitcoin.** Ce guide explique l'essentiel en mots simples.

> Un *chama* est une tontine d'Afrique de l'Est — des voisins qui mettent en commun ce qu'ils ont et
> se font confiance pour régler les comptes. Chama offre ce même cercle au monde entier, sauf qu'ici
> la confiance est cryptographique. Il n'y a aucune entreprise au milieu : juste vous, votre
> interlocuteur, votre communauté et Nostr.

---

## L'essentiel

### Qu'est-ce que Chama ?
Une place de marché pair-à-pair. Vous pouvez acheter et vendre des bitcoins, des biens et des
services avec les gens de votre communauté. Chaque échange est protégé par une **mise sous séquestre**
qu'aucune entreprise ne peut geler, saisir ou bloquer — car il n'y a aucune entreprise au milieu.

### Dois-je connaître le Bitcoin ?
Non. Vous choisissez votre pays et votre monnaie, vous échangez, et (dans les pays pris en charge)
votre argent peut arriver directement sur votre compte d'argent mobile. Le Bitcoin, c'est la
tuyauterie ; vous n'avez pas à y penser.

### Chama est-il gratuit ? Quels sont les frais ?
L'application est gratuite à télécharger. Des **frais de plateforme de 0,5 %**, prélevés via Lightning, s'appliquent à un échange
abouti, et si un échange est tranché par un **arbitre** de la communauté en cas de litige, de petits
frais d'arbitrage peuvent s'appliquer. Les vendeurs peuvent aussi fixer une **prime** sur une annonce
(p. ex. « +25 % ») — c'est le prix du vendeur, pas un frais Chama, et vous voyez toujours le montant
final avant de vous engager.

### Est-ce que Chama détient mon argent ?
**Non.** Chama ne touche jamais votre argent. Vos fonds restent sous séquestre **uniquement pendant un
échange actif**, puis vous reviennent dès que l'échange est réglé. Entre deux échanges, votre solde est
à zéro par conception — il n'y a aucun portefeuille à vider.

---

## Pour commencer

### Comment obtenir Chama ?
- **Android :** installez depuis Zapstore → https://zapstore.dev/apps/app.chama.market
- **Web & ordinateur :** ouvrez getchama.app (aussi sur chama.community)

### Comment me connecter ?
Chama utilise une **clé** comme compte (le standard Nostr) — pas d'e-mail, pas de mot de passe, pas de
formulaire d'inscription. L'application peut créer une clé pour vous, ou vous pouvez utiliser votre clé
Nostr existante. **Notez votre clé et gardez-la en lieu sûr** (voir « Sauvegardez votre compte »
ci-dessous) — c'est *elle*, votre compte.

### Qu'est-ce qu'une « communauté » et comment la choisir ?
Une communauté, c'est votre **monnaie + pays + drapeau** — par exemple 🇸🇳 Sénégal · CFA, 🇨🇲 Cameroun ·
CFA, ou 🇰🇪 Kenya · KES. Vous choisissez la vôtre à la première connexion. Elle détermine la monnaie de
vos échanges et les voisins avec qui vous échangez. Vous pouvez en changer plus tard dans
**Réglages → Avancé**, mais vous restez « chez vous » par défaut. Vous pouvez aussi jeter un œil aux
autres communautés en parcourant les annonces.

---

## Acheter & vendre

### Comment acheter ?
1. Dans **Parcourir**, touchez une annonce qui vous intéresse.
2. Touchez **Rejoindre comme acheteur** pour réserver votre place (rien ne bouge encore).
3. Composez votre commande / confirmez le montant, puis **financez** — vos sats sont alors verrouillés
   en toute sécurité sous séquestre.
4. Payez le vendeur en monnaie locale (p. ex. Orange Money, Wave, MoMo) comme l'indique l'annonce, ou
   recevez vos biens.
5. Quand vous avez reçu ce que vous avez payé, touchez **libérer** — les sats vont au vendeur. Terminé.

### Comment vendre ?
1. Touchez **Créer** et publiez une annonce (Échange / Biens / Paiement de factures), fixez votre prix
   et les moyens de paiement acceptés.
2. Quand un acheteur rejoint et finance, les sats se verrouillent sous séquestre — vous verrez
   « **Sats verrouillés sous séquestre** ».
3. Livrez le bien / envoyez la monnaie convenue, puis touchez **Marquer comme livré** (ou « Marquer
   comme envoyé ») — c'est votre confirmation.
4. Une fois libéré, touchez **Réclamer** pour recevoir vos sats — et encaissez (voir plus bas).

### Quelles sont les étapes d'un échange ?
**Réservé** (quelqu'un a rejoint) → **Verrouillé** (sats financés sous séquestre) → l'action se déroule
(biens livrés / monnaie envoyée) → **Libéré** (les deux parties sont d'accord) → **Réclamez** votre
versement → **Réglé.** Vous suivez tout sur la frise de l'échange, et pouvez discuter avec l'autre
partie à tout moment.

### En quoi le séquestre me protège-t-il ?
Quand un échange est financé, l'argent est réparti de sorte que **deux des trois** personnes de
l'échange — vous, votre interlocuteur et un **arbitre** de la communauté — doivent être d'accord pour
qu'il bouge. Personne seul (et aucune entreprise) ne peut partir avec. Normalement, vous et votre
interlocuteur êtes simplement d'accord et l'échange se règle ; l'arbitre n'intervient qu'en cas de
problème.

### Qu'est-ce qu'un arbitre ?
Un membre de confiance de votre communauté qui aide à trancher un échange **uniquement en cas de
litige**. Il ne peut pas prendre votre argent — il ne peut que départager acheteur et vendeur. Les
arbitres bâtissent une réputation au fil du temps.

### Et si quelque chose tourne mal / en cas de litige ?
Si vous et votre interlocuteur n'êtes pas d'accord (p. ex. un bien non reçu), chacun exprime son vote —
**libérer** ou **rembourser** — en expliquant pourquoi. En cas de désaccord, l'arbitre intervient pour
décider équitablement. Vous n'êtes jamais bloqué.

### Comment annuler ou me rétracter ?
Tant que rien n'est financé, vous pouvez simplement partir. Après le financement, se rétracter revient
à voter **remboursement**, qui renvoie les sats à la bonne personne (l'arbitre est le filet de
sécurité). Chama vous montre toujours où va l'argent avant de confirmer.

---

## Récupérer votre argent

### D'où viennent les sats pour financer un échange ?
Vous financez avec des bitcoins (sats) que vous détenez déjà — par exemple depuis un portefeuille
Lightning. Chama ne vous vend pas de bitcoins dans l'application. Dans un échange typique, le **côté
monnaie se passe directement entre vous et votre interlocuteur** (vous lui envoyez Orange Money/Wave/MoMo
comme l'indique l'annonce) ; Chama met sous séquestre le côté **Bitcoin**.

### Comment être payé / encaisser ?
Quand un échange est prêt, touchez **Réclamer** et choisissez où va votre argent. Les options dépendent
de votre pays :
- **Partenaire local.** Là où un partenaire d'encaissement existe (p. ex. Banxaas au Sénégal), Chama
  ouvre sa page pour que vous encaissiez chez lui. D'autres partenaires arrivent.
- 🇰🇪 **Kenya — encaissement M-Pesa en un geste.** Saisissez votre numéro M-Pesa et les shillings
  arrivent en quelques secondes. Le même encaissement instantané vers l'argent mobile (Orange Money,
  Wave, MoMo) **arrive** dans les pays francophones.
- **Lightning, partout.** Envoyez vers n'importe quelle adresse Lightning, facture, ou portefeuille
  connecté (NWC).
- **Bitcoin on-chain.** Collez une adresse Bitcoin (plus lent ; frais de réseau).

### Puis-je *payer* un échange en argent mobile (pas en Bitcoin) ?
Pas dans l'application pour l'instant. **Encaisser** vers l'argent mobile fonctionne dans les pays pris
en charge ; **convertir** votre argent mobile en Bitcoin se fait au préalable avec un service externe,
ou directement avec votre partenaire d'échange.

---

## Votre compte & sécurité

### Mon argent est-il en sécurité ?
Oui — vos fonds sont protégés par le séquestre « deux sur trois » et ne sont engagés que dans un échange
précis. Chama, et toute entité « Chama », **ne peut pas** les saisir, les geler ni les déplacer.

### Sauvegardez votre compte (important !)
Votre **clé** est votre compte et votre seul moyen de récupération. Si vous perdez votre téléphone sans
sauvegarde, vous pourriez perdre l'accès. Donc :
- À la connexion, **enregistrez votre clé / phrase de récupération** en lieu sûr et privé (notez-la hors
  ligne ; ne la partagez jamais).
- Quiconque détient votre clé contrôle votre compte — traitez-la comme de l'argent liquide.

### Chama respecte-t-il ma vie privée ?
Vous ne donnez à Chama ni e-mail, ni numéro, ni pièce d'identité. Votre identité, c'est juste votre clé.
Gardez à l'esprit que ce que vous publiez publiquement (annonces, messages d'un échange) circule sur le
réseau Nostr.

---

## Dépannage

### Il affiche « Connexion… » ou demande de « Reconnecter ».
Chama communique avec le réseau via des relais. Sur une connexion faible, quelques-uns peuvent tomber —
touchez **Reconnecter**, ou patientez un instant ; il se reconnecte tout seul. Vos échanges et vos fonds
ne sont jamais perdus pendant ce temps.

### J'ai terminé un échange mais il dit que ma réclamation « nécessite votre attention ».
En général, votre argent est déjà arrivé et l'application n'a simplement pas pu le confirmer
automatiquement — vérifiez votre solde ou votre portefeuille. Chama garde une copie de secours dans tous
les cas, donc rien n'est perdu. Si l'argent manque réellement, la note enregistrée est votre voie de
récupération.

### Le financement ou la réclamation a échoué.
Rien ne bouge sans réussite complète — un échec signifie qu'**aucun sat n'a été envoyé.** Patientez puis
réessayez ; si une voie reste lente, touchez d'abord **Reconnecter**. Sur une toute nouvelle
installation, si une première connexion bloque, vérifiez votre réseau et réessayez.

---

## Mini-glossaire
- **Sats :** la petite unité du Bitcoin (1 Bitcoin = 100 000 000 sats). Les prix s'affichent aussi dans
  votre monnaie locale.
- **Lightning :** le réseau de paiement Bitcoin rapide et bon marché que Chama utilise pour déplacer les sats.
- **Séquestre :** une « consignation » sûre des fonds pendant un échange, libérée seulement quand les
  bonnes personnes sont d'accord.
- **Arbitre :** un membre de la communauté qui peut trancher un échange en litige — sans jamais pouvoir
  prendre votre argent.
- **Clé / npub :** votre compte sur Chama (et Nostr). Sauvegardez-la.
- **Argent mobile :** Orange Money, Wave, MoMo, M-Pesa, etc. — selon votre pays.

---

## Besoin d'aide ?
- App : getchama.app · Android : https://zapstore.dev/apps/app.chama.market
- Suivez Chama sur Nostr : `npub1m7nypkfk259h5h0dqwj9px0pqq7nz0cs7gjdhr7g793wspskeavqrljsln`

*Échangez avec votre communauté. Faites confiance aux maths, pas à un intermédiaire.* ⚡🌍
