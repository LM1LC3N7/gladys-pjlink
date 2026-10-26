# Vidéoprojecteurs PJLink pour Gladys

Pilotez vos **vidéoprojecteurs PJLink** depuis Gladys, en local, sans aucun
cloud : allumage, mise en veille, entrée, sourdine A/V, heures de lampe et
rapport d'erreurs. PJLink est le standard de contrôle réseau de nombreux
vidéoprojecteurs et de certains écrans (Epson, Panasonic, NEC / Sharp, Sony,
BenQ, Canon, Hitachi / Maxell, Optoma, Ricoh, Christie...), classe 1 et
classe 2.

> **Important.** Cette intégration n'a jamais été testée avec un vrai
> appareil : elle a été écrite d'après la spécification publique PJLink,
> recoupée avec la bibliothèque `pypjlink2` (celle qu'utilise Home Assistant),
> et testée contre un faux vidéoprojecteur seulement. Vos retours sont les
> bienvenus.
> Intégration non officielle, sans lien avec la JBMIA (l'association à
> l'origine de PJLink) ni avec un fabricant de vidéoprojecteurs.

## Installation

1. Sur le vidéoprojecteur, activez **PJLink** (selon la marque : _Réseau_ >
   _Contrôle réseau_, _PJLink_, _Commande_...) et la **veille réseau** (par
   exemple _Mode veille : Réseau activé_). Sans elle, le vidéoprojecteur
   quitte le réseau en veille et ne peut pas être allumé depuis Gladys.
2. Donnez à chaque vidéoprojecteur une **adresse IP fixe** dans votre box
   (bail DHCP réservé).
3. Dans Gladys, installez l'intégration **PJLink Projectors**, puis ouvrez sa
   configuration.
4. Saisissez les adresses IP, séparées par des virgules (par exemple
   `192.168.1.60, 192.168.1.61`, 10 au plus). Ajoutez `:port` seulement si le
   vidéoprojecteur n'utilise pas le port PJLink, 4352.
5. Si un mot de passe PJLink protège vos vidéoprojecteurs, saisissez-le
   (32 caractères au plus, sans accents, le même pour tous).
6. Ouvrez l'onglet **Découverte** et lancez la recherche : les
   vidéoprojecteurs apparaissent, créez-les.

L'intégration parle au vidéoprojecteur en **PJLink** (port TCP 4352) : une
connexion à la fois (un vidéoprojecteur n'en accepte qu'une), fermée après
3 s de silence. Elle lit l'état à l'intervalle de rafraîchissement de la
configuration (60 s par défaut, 30 s au moins).

## Ce que vous obtenez

| Fonction         | Type Gladys            | Remarque                                                          |
| ---------------- | ---------------------- | ----------------------------------------------------------------- |
| Marche           | état binaire (lecture) | 1 allumé ou en préchauffage, 0 en veille ou refroidissement       |
| Allumer          | bouton                 | envoyé seulement depuis la veille                                 |
| Mettre en veille | bouton                 | la commande protectrice, voir plus bas                            |
| État             | texte (lecture)        | Standby, Warming up, On, Cooling down, Unreachable...             |
| Entrée           | liste                  | les entrées que liste le vidéoprojecteur, avec leur nom           |
| Sourdine A/V     | bouton (sourdine)      | chaque appui lit l'état, puis règle l'inverse                     |
| Heures de lampe  | durée en heures        | la première lampe ; absente sur les modèles qui ne la donnent pas |
| Erreurs          | texte (lecture)        | `OK`, ou par exemple `Lamp: warning, Filter: error`               |

Volontairement, pas d'**interrupteur** : un « tout éteindre » ou « tout
allumer » d'un assistant vocal ou d'une scène n'allume ni ne coupe votre
vidéoprojecteur.

L'entrée et la sourdine A/V ne sont lues et réglées que vidéoprojecteur
allumé. Les noms des entrées viennent du vidéoprojecteur (classe 2 :
`HDMI 1`...) ; sur un vidéoprojecteur de classe 1, elles sont nommées par
type (`Digital 1`, `RGB 1`...). Ils sont lus quand vous lancez la recherche
dans l'onglet Découverte.

Chaque vidéoprojecteur est reconnu par son **numéro de série** (classe 2), ou
par son **adresse** (classe 1, ou un vidéoprojecteur qui n'en donne pas).
Avant de publier ou d'envoyer quoi que ce soit (hors mise en veille),
l'intégration vérifie une fois par connexion qu'elle parle au même
vidéoprojecteur : le numéro de série, ou la marque et le modèle pour un
vidéoprojecteur reconnu par son adresse. Un autre numéro de série à
l'adresse : le vidéoprojecteur est marqué « Another projector at this
address » et rien ne lui est envoyé ; saisissez sa nouvelle adresse et
relancez la recherche. Illisible : son état affiche « Identity not
confirmed » et rien ne lui est envoyé sauf la mise en veille.

## Commandes

Allumer, l'entrée et la sourdine A/V lisent l'état de marche juste avant,
puis la valeur en cours, et décident sur ce qu'elles lisent. Une commande
n'est réussie qu'une fois que le vidéoprojecteur montre la valeur demandée à
la relecture ; Gladys donne 5 secondes à une commande, chaque commande reçoit
donc sa réponse en 3,5 s, avec exactement ce qui est su :

- « rien envoyé » : le vidéoprojecteur n'a pas répondu, un mot de passe
  manque ou est refusé, l'identité n'est pas confirmée, une mise en veille a
  été demandée entre-temps ou n'est pas encore confirmée (entrée et sourdine
  A/V), ou il ne restait plus de temps ;
- « envoyée, sans confirmation » ou « pas encore appliquée » : la commande
  est partie ; le vidéoprojecteur est relu 5 s et 20 s plus tard ;
- « refusée par le vidéoprojecteur (ERR3) » : le vidéoprojecteur a répondu
  par une erreur (ERR3 veut dire « pas maintenant », par exemple pendant le
  préchauffage).

Les commandes à un même vidéoprojecteur partent une à la fois.

### La mise en veille, commande protectrice

La mise en veille n'est retenue ni par une lecture ou une commande en cours,
ni par les commandes en attente, ni par la configuration pas encore lue, ni
par un état pas encore lu :

- elle passe devant tout ce qui attend pour ce vidéoprojecteur ; les
  commandes demandées avant elle et encore en attente sont annulées (« rien
  envoyé ») : rien de ce qui a été demandé avant une mise en veille ne part
  après elle ;
- une lecture bloquée depuis 1 s (aucun octet du vidéoprojecteur) est
  coupée, et la mise en veille part sur une nouvelle connexion une fois
  l'ancienne fermée ;
- `POWR 0` est envoyé sans rien lire avant, puis l'état de marche est relu :
  « Standby » ou « Cooling down » la confirme ;
- quand aucune connexion ne s'établit, elle est réessayée toutes les 250 ms
  dans ses 3,2 s.

Une mise en veille **acceptée** par le vidéoprojecteur (`OK`) n'est jamais
renvoyée à l'aveugle : si l'état relu le montre encore allumé, elle n'est
renvoyée que par une lecture qui le montre encore allumé, sans lecture
échouée entre-temps ; une lecture qui échoue, ou qui le montre en
préchauffage (un allumage lancé depuis, par la télécommande ou par Gladys),
l'abandonne. Acceptée mais pas relue (beaucoup de vidéoprojecteurs quittent
le réseau pendant le refroidissement) : elle n'est pas renvoyée.

Une mise en veille **non acceptée** (refusée par ERR3 pendant le
préchauffage, ou sans connexion, ou sans réponse) est **gardée** (dans les
données de l'intégration : un redémarrage la garde aussi) et renvoyée par
les lectures suivantes qui montrent le vidéoprojecteur allumé : ses propres
lectures de l'état de marche toutes les 12 s (quel que soit l'intervalle de
rafraîchissement, arrêtées dès qu'elle est confirmée ou abandonnée) et les
lectures habituelles, 3 fois au plus, les refus ERR3 (préchauffage ou refroidissement) n'étant pas
comptés, pendant 2 minutes au plus (comptées
sur une horloge monotone tant que l'intégration tourne). Tant que le
vidéoprojecteur préchauffe, elle attend. Elle est abandonnée dès qu'une
lecture montre le vidéoprojecteur en veille ou en refroidissement, ou quand
un « Allumer » envoyé depuis Gladys après elle est accepté.

Au redémarrage, une mise en veille gardée non acceptée est décidée sur une
lecture de l'état d'abord, avant la lecture de la configuration et avant
toute lecture : envoyée seulement si le vidéoprojecteur est encore allumé.
Une mise en veille acceptée est abandonnée au redémarrage.

Les cas où une mise en veille ne part pas (« rien envoyé », gardée et
renvoyée comme ci-dessus) :

1. l'adresse du vidéoprojecteur est inconnue (un autre vidéoprojecteur y
   répond, preuve à l'appui) ;
2. le vidéoprojecteur demande un mot de passe et aucun n'est saisi, ou celui
   saisi a été refusé (un mot de passe refusé n'est pas renvoyé par une mise
   en veille ; juste après un redémarrage, un vidéoprojecteur qui demande un
   mot de passe reçoit la mise en veille une fois la configuration lue) ;
3. aucune connexion dans ses 3,2 s (injoignable).

## Mots de passe

Un mot de passe manquant ou refusé bloque son vidéoprojecteur : ni lecture, ni
commande, ni nouvel essai automatique, reconnexion ou redémarrage compris.
L'état de l'intégration le dit. Le blocage est levé quand vous changez le mot
de passe dans la configuration, ou quand le bouton **Vérifier les
vidéoprojecteurs** réussit (chaque appui fait un essai ; après un redémarrage,
un nouveau mot de passe est reconnu par sa marque, voir plus bas, et dans
1 cas sur 64 il est pris pour l'ancien : appuyez alors sur le bouton). Le mot
de passe est gardé par Gladys dans sa base, jamais réaffiché, envoyé
seulement aux vidéoprojecteurs sous la forme MD5 qu'utilise PJLink, jamais
écrit dans les journaux ni dans les données de l'intégration. Pour savoir
après un redémarrage si le mot de passe a changé, l'intégration garde
seulement une marque de 6 bits d'un mot de passe refusé (une valeur parmi 64,
qui n'identifie rien), effacée dès qu'un mot de passe est accepté.

## Vérifier les vidéoprojecteurs

Le bouton **Vérifier les vidéoprojecteurs** montre l'état de chaque
vidéoprojecteur. Un vidéoprojecteur lu il y a moins d'un intervalle de
rafraîchissement est montré tel que lu, sans être réinterrogé ; une
recherche, une reconnexion ou une configuration enregistrée ne le font pas
lire plus tôt non plus.

## Pas encore pris en charge

Le volume, le gel d'image, les heures de filtre, les notifications de la
classe 2 (recherche par diffusion UDP, état poussé par le vidéoprojecteur),
un mot de passe par vidéoprojecteur. Voir le TODO.md du projet.
