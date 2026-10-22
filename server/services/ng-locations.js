"use strict";
/* ============================================================================
   NIGERIA LOCATIONS — states, cities (LGAs / area councils) and towns
   ----------------------------------------------------------------------------
   One dataset, two consumers: the public directory search (State -> City ->
   Town cascading selects, served by GET /api/public/locations) and the
   registration forms, which let an applicant pick the same way instead of
   typing free text that can never be filtered.

   Shape: { "<State>": { capital, cities: { "<City / LGA>": ["<Town>", ...] } } }

   37 entries (36 states + the Federal Capital Territory), 774 LGAs / area
   councils, with the towns and districts under each. Pure data: no imports,
   no I/O, so it loads the same in the server, in tests and in a worker.
   ========================================================================== */

const LOCATIONS = {
 "Abia": {
  "capital": "Umuahia",
  "cities": {
   "Aba North": [
    "Aba Town",
    "Ariaria",
    "Eziama",
    "Ogbor Hill",
    "Umuola"
   ],
   "Aba South": [
    "Aba Main Town",
    "Asa",
    "Ndiegoro",
    "Osusu",
    "Umungasi"
   ],
   "Arochukwu": [
    "Amuvi",
    "Arochukwu Town",
    "Ibom",
    "Ihechiowa",
    "Obinkita",
    "Ututu"
   ],
   "Bende": [
    "Alayi",
    "Bende Town",
    "Igbere",
    "Item",
    "Ozuitem",
    "Umuimenyi"
   ],
   "Ikwuano": [
    "Ariam",
    "Ibere",
    "Isiala Oboro",
    "Oloko",
    "Umudike",
    "Usaka"
   ],
   "Isiala Ngwa North": [
    "Ntigha",
    "Okpuala Ngwa",
    "Umuaro"
   ],
   "Isiala Ngwa South": [
    "Mbawsi",
    "Omoba",
    "Ovom",
    "Umuojima"
   ],
   "Isuikwuato": [
    "Mbalano",
    "Uturu"
   ],
   "Obi Ngwa": [
    "Ipu",
    "Mgboko",
    "Ntigha Obi",
    "Ohanze",
    "Umuolu"
   ],
   "Ohafia": [
    "Abiriba",
    "Amaekpu",
    "Ebem",
    "Elu",
    "Nkporo",
    "Ohafia Town"
   ],
   "Osisioma": [
    "Ahia Ohuru",
    "Amaogwugwu",
    "Osisioma Ngwa",
    "Umuocham"
   ],
   "Ugwunagbo": [
    "Ntalakwu",
    "Obuda",
    "Ugwunagbo Town",
    "Umuzom"
   ],
   "Ukwa East": [
    "Akwete",
    "Ngwaiyiekwe",
    "Obehie",
    "Oke-Ikpe"
   ],
   "Ukwa West": [
    "Asa Ukwa",
    "Oboro",
    "Ohambele",
    "Ohuru",
    "Umuokwor"
   ],
   "Umuahia North": [
    "Apumiri",
    "Ibeku",
    "Isingwu",
    "Nkwoegwu",
    "Umuahia Town"
   ],
   "Umuahia South": [
    "Apia",
    "Ohuhu",
    "Old Umuahia",
    "Ubakala",
    "Umuawa"
   ],
   "Umu Nneochi": [
    "Ihube",
    "Isuochi",
    "Lokpa",
    "Okpuala",
    "Ozu Abam"
   ]
  }
 },
 "Adamawa": {
  "capital": "Yola",
  "cities": {
   "Demsa": [
    "Borrong",
    "Demsa Town",
    "Gwamba",
    "Ribadu"
   ],
   "Fufure": [
    "Fufure Town",
    "Gurin",
    "Pariya",
    "Sugu"
   ],
   "Ganye": [
    "Ganye Town",
    "Gumti",
    "Jaggu",
    "Sugu Ganye",
    "Timdore"
   ],
   "Gayuk": [
    "Chikila",
    "Gayuk Town",
    "Lagdo"
   ],
   "Gombi": [
    "Boaz",
    "Garkida",
    "Gombi Town",
    "Guyaku",
    "Tawa"
   ],
   "Grie": [
    "Grie Town",
    "Ndikong",
    "Yelwa"
   ],
   "Hong": [
    "Hong Town",
    "Kwarhi",
    "Mayo Kuli",
    "Shangui",
    "Uba"
   ],
   "Jada": [
    "Jada Town",
    "Mapeo",
    "Mbulo"
   ],
   "Lamurde": [
    "Kwaja",
    "Lamurde Town",
    "Tola",
    "Waltandi"
   ],
   "Madagali": [
    "Duhu",
    "Gulak",
    "Madagali Town",
    "Pallam",
    "Shuwa",
    "Wagga"
   ],
   "Maiha": [
    "Belel",
    "Humbutudi",
    "Maiha Town",
    "Mayo Ine"
   ],
   "Mayo Belwa": [
    "Betso",
    "Binyeri",
    "Jereng",
    "Mayo Belwa Town",
    "Ndikong",
    "Sorau"
   ],
   "Michika": [
    "Bazza",
    "Futudou",
    "Lughu",
    "Michika Town",
    "Moda"
   ],
   "Mubi North": [
    "Digil",
    "Kolere",
    "Lokuwa",
    "Mubi Town",
    "Yelwa"
   ],
   "Mubi South": [
    "Bahuli",
    "Dugunyi",
    "Gella",
    "Mubi South Town",
    "Vimtim"
   ],
   "Numan": [
    "Bolki",
    "Gaanda",
    "Imburu",
    "Kodomti",
    "Numan Town"
   ],
   "Shelleng": [
    "Bakta",
    "Bodeno",
    "Gundo",
    "Libbo",
    "Shelleng Town"
   ],
   "Song": [
    "Gudu",
    "Gyawana",
    "Song Town",
    "Waltandi",
    "Zumo"
   ],
   "Toungo": [
    "Dowaya",
    "Gurum",
    "Mbamba",
    "Toungo Town"
   ],
   "Yola North": [
    "Alkalawa",
    "Bachure",
    "Doubeli",
    "Jimeta",
    "Karewa"
   ],
   "Yola South": [
    "Bagale",
    "Limawa",
    "Namtari",
    "Nasarawo Jereng",
    "Yola Town"
   ]
  }
 },
 "Akwa Ibom": {
  "capital": "Uyo",
  "cities": {
   "Abak": [
    "Abak Town",
    "Afaha Obong",
    "Ikot Nkor",
    "Midim",
    "Otoro"
   ],
   "Eastern Obolo": [
    "Ataba",
    "Iko",
    "Ikuru Town",
    "Ine Town",
    "Okoroete"
   ],
   "Eket": [
    "Afaha Eket",
    "Eket Town",
    "Idua",
    "Ikot Ebidang",
    "Ikot Udo"
   ],
   "Esit Eket": [
    "Ekpene Obo",
    "Ikot Ukap",
    "Mbo Ime",
    "Okoroutip",
    "Uquo"
   ],
   "Essien Udim": [
    "Adiasim",
    "Afaha Ikot Ebak",
    "Ikot Eyo",
    "Ikot Okoro",
    "Ukana"
   ],
   "Etim Ekpo": [
    "Ikot Akpan",
    "Ikot Ekpene Etim",
    "Ikot Ukana",
    "Utu Etim Ekpo"
   ],
   "Etinan": [
    "Afaha Etinan",
    "Etinan Town",
    "Ikot Abasi Itam",
    "Ikot Ebak",
    "Nung Udoe"
   ],
   "Ibeno": [
    "Ewa Oro",
    "Eyo Abasi",
    "Iwuo Okpom",
    "Mkpanak",
    "Upenekang"
   ],
   "Ibesikpo Asutan": [
    "Ididep",
    "Ikot Ebiere",
    "Ikot Nkwa",
    "Ikot Oku Ikono",
    "Nung Udoe"
   ],
   "Ibiono Ibom": [
    "Ikot Edor",
    "Ikot Ibritam",
    "Ikot Obio Edim",
    "Ikot Obio Itong",
    "Nkpa"
   ],
   "Ika": [
    "Afaha Ika",
    "Ikot Akpan Ika",
    "Ikot Okwot",
    "Ikot Ubo",
    "Ito Ika"
   ],
   "Ikono": [
    "Ibiaku Ikono",
    "Ikot Akpan Eda",
    "Ikot Ekpene Ikono",
    "Ito",
    "Obio Ikono"
   ],
   "Ikot Abasi": [
    "Ikot Abasi Town",
    "Ikot Abia",
    "Ikot Akpaden",
    "Ikot Idem",
    "Mkpat Abasi"
   ],
   "Ikot Ekpene": [
    "Ibekwe",
    "Ikot Ekpene Town",
    "Ikot Itie",
    "Ikot Ntuen",
    "Ndon Eyo"
   ],
   "Ini": [
    "Ikot Akpa Ini",
    "Ikot Ntuen",
    "Ikot Umoh Ini",
    "Itak",
    "Nkari"
   ],
   "Itu": [
    "Ikot Ekpene Itu",
    "Ikot Okubo",
    "Itu Town",
    "Mbiabong",
    "Ntak Inyang"
   ],
   "Mbo": [
    "Ebughu",
    "Effiat",
    "Itak Abasi",
    "Mbo Town",
    "Okopedi",
    "Udesi"
   ],
   "Mkpat Enin": [
    "Ikot Abasi Mkpat",
    "Ikot Ibiok",
    "Ikot Okure",
    "Mkpat Enin Town",
    "Use Ikot Amama"
   ],
   "Nsit Atai": [
    "Akpa",
    "Edem Itam",
    "Ikot Abia",
    "Ikot Ukpong",
    "Odoro Ikot"
   ],
   "Nsit Ibom": [
    "Ikot Okpon",
    "Ikot Ukpong Nsit",
    "Itak",
    "Mbak",
    "Nung Ikono"
   ],
   "Nsit Ubium": [
    "Ikot Akpa Nkuk",
    "Ikot Obio Etok",
    "Ikot Uso Akpan",
    "Itak Ikot Akpan",
    "Ntak Inyang"
   ],
   "Obot Akara": [
    "Ikot Akpan Abia",
    "Ikot Ibok",
    "Ikot Obong",
    "Nto Ndang",
    "Obot Akara Town"
   ],
   "Okobo": [
    "Ekeya",
    "Ibaka",
    "Ikot Ekong",
    "Ikot Iba",
    "Okobo Town"
   ],
   "Onna": [
    "Abat",
    "Ikot Abasi Onna",
    "Mkpok",
    "Okon",
    "Onna Town"
   ],
   "Oron": [
    "Idua Oron",
    "Iquita",
    "Okobo Oron",
    "Oron Town"
   ],
   "Oruk Anam": [
    "Ikot Abasi Oruk",
    "Ikot Ekong",
    "Ikot Obio Ata",
    "Ikot Okpora",
    "Ukpom"
   ],
   "Udung Uko": [
    "Ikot Itie",
    "Ikot Ukpong",
    "Ikpe Ikot Nkon",
    "Okiuso",
    "Udung Uko Town"
   ],
   "Ukanafun": [
    "Ikot Akpan",
    "Ikot Obio Ukanafun",
    "Ikot Udo",
    "Ndiya",
    "Ukanafun Town"
   ],
   "Uruan": [
    "Ibiaku Uruan",
    "Idu Uruan",
    "Ikot Ekpene Uruan",
    "Ikot Ikpe",
    "Nung Oku"
   ],
   "Urue-Offong/Oruko": [
    "Eyofin",
    "Ikot Akpa",
    "Ikot Ebom",
    "Ikot Mbo",
    "Okopedi"
   ],
   "Uyo": [
    "Ewet Housing",
    "Ibesikpo",
    "Shelter Afrique",
    "Uyo Town"
   ]
  }
 },
 "Anambra": {
  "capital": "Awka",
  "cities": {
   "Aguata": [
    "Aguluezechukwu",
    "Ekwulobia",
    "Igboukwu",
    "Isuofia",
    "Nkpologwu",
    "Umuona"
   ],
   "Anambra East": [
    "Aguleri",
    "Igbariam",
    "Nando",
    "Nsugbe",
    "Otuocha",
    "Umueri"
   ],
   "Anambra West": [
    "Ifite Ogwari",
    "Nneyi Umuleri",
    "Nzam",
    "Oroma Etiti",
    "Umueze Anam"
   ],
   "Anaocha": [
    "Adazi Nnukwu",
    "Adazi-Ani",
    "Agulu",
    "Neni",
    "Nri",
    "Obeledu"
   ],
   "Awka North": [
    "Achalla",
    "Amansea",
    "Awba Ofemili",
    "Isuaniocha",
    "Mgbakwu",
    "Ugbenu"
   ],
   "Awka South": [
    "Amawbia",
    "Awka Town",
    "Mbaukwu",
    "Nibo",
    "Nise",
    "Okpuno"
   ],
   "Ayamelum": [
    "Anaku",
    "Ifite Ogwari",
    "Igbakwu",
    "Omasi",
    "Omor",
    "Umumbo"
   ],
   "Dunukofia": [
    "Ezinifite",
    "Nawfia",
    "Ukpo",
    "Ukwulu",
    "Umudioka",
    "Umunnachi"
   ],
   "Ekwusigo": [
    "Ekwulumili",
    "Ichi",
    "Ihembosi",
    "Ohaji",
    "Oraifite",
    "Ozubulu"
   ],
   "Idemili North": [
    "Abatete",
    "Eziowelle",
    "Nkpor",
    "Oba",
    "Ogidi",
    "Uke"
   ],
   "Idemili South": [
    "Akwu Ukwu",
    "Alor",
    "Nnobi",
    "Oba",
    "Obosi",
    "Ojoto"
   ],
   "Ihiala": [
    "Azia",
    "Ihiala Town",
    "Lilu",
    "Okija",
    "Orsumoghu",
    "Uli"
   ],
   "Njikoka": [
    "Abagana",
    "Abba",
    "Enugu-Agidi",
    "Enugwu-Ukwu",
    "Nawfia",
    "Nimo"
   ],
   "Nnewi North": [
    "Nnewi Town",
    "Nnewi-Ichi",
    "Nnewichi",
    "Otolo",
    "Umudim",
    "Uruagu"
   ],
   "Nnewi South": [
    "Amichi",
    "Azigbo",
    "Ebenator",
    "Ukpo",
    "Ukpor",
    "Utuh"
   ],
   "Ogbaru": [
    "Amiyi",
    "Atani",
    "Ochuche Umuodu",
    "Odekpe",
    "Ogwu Ikpele",
    "Okpoko"
   ],
   "Onitsha North": [
    "Fegge",
    "GRA Onitsha",
    "Odoakpu",
    "Onitsha Main Market",
    "Woliwo"
   ],
   "Onitsha South": [
    "Awada",
    "Inland Town",
    "Odume",
    "Ogbeolu",
    "Omagba"
   ],
   "Orumba North": [
    "Ajali",
    "Awgbu",
    "Nanka",
    "Ndikelionwu",
    "Oko",
    "Ufuma"
   ],
   "Orumba South": [
    "Awa",
    "Eziagu",
    "Ezira",
    "Ihite",
    "Ogbunka",
    "Umunze"
   ],
   "Oyi": [
    "Awkuzu",
    "Nkwelle Ezunaka",
    "Nteje",
    "Ogbunike",
    "Umunya"
   ]
  }
 },
 "Bauchi": {
  "capital": "Bauchi",
  "cities": {
   "Alkaleri": [
    "Alkaleri Town",
    "Duguri",
    "Futuk",
    "Gar",
    "Pali",
    "Yelwa Alkaleri"
   ],
   "Bauchi": [
    "Bauchi Town",
    "Dungal",
    "Gwallameji",
    "Makama",
    "Wunti",
    "Yelwa Tudu"
   ],
   "Bogoro": [
    "Bogoro Town",
    "Kwaltaki",
    "Tapshin"
   ],
   "Damban": [
    "Damban Town",
    "Ragwam",
    "Yaya",
    "Zindi"
   ],
   "Darazo": [
    "Darazo Town",
    "Gabarin",
    "Lanzai",
    "Sade"
   ],
   "Dass": [
    "Bununu",
    "Dass Town",
    "Gwada",
    "Mundi",
    "Zumbul"
   ],
   "Gamawa": [
    "Bulkachuwa",
    "Gamawa Town",
    "Udubo",
    "Yunusari"
   ],
   "Ganjuwa": [
    "Buzaye",
    "Ganjuwa Town",
    "Jugudu",
    "Kafin Madaki"
   ],
   "Giade": [
    "Dagauda",
    "Giade Town",
    "Karfi",
    "Kuka",
    "Zaura"
   ],
   "Itas/Gadau": [
    "Gadau",
    "Itas",
    "Kanya",
    "Madara",
    "Rumi"
   ],
   "Jama'are": [
    "Ajiya",
    "Chinade",
    "Dogon Jeji",
    "Gundumi",
    "Jama'are Town"
   ],
   "Katagum": [
    "Azare",
    "Chinade",
    "Jambo",
    "Madangala",
    "Madara"
   ],
   "Kirfi": [
    "Dangari",
    "Gar",
    "Kirfi Town",
    "Wanka"
   ],
   "Misau": [
    "Gubi",
    "Hardawa",
    "Misau Town",
    "Tofa",
    "Zadawa"
   ],
   "Ningi": [
    "Burra",
    "Dawaki",
    "Gwaram",
    "Kafin Madaki",
    "Ningi Town",
    "Tiffi"
   ],
   "Shira": [
    "Disina",
    "Gubi",
    "Shira Town",
    "Yana",
    "Zindi"
   ],
   "Tafawa Balewa": [
    "Bula",
    "Burra",
    "Gar",
    "Lere",
    "Tafawa Balewa Town"
   ],
   "Toro": [
    "Gumau",
    "Lame",
    "Rahama",
    "Toro Town"
   ],
   "Warji": [
    "Bumba",
    "Dagwama",
    "Gar Warji",
    "Gwaltu",
    "Warji Town"
   ],
   "Zaki": [
    "Kari",
    "Katagum Zaki",
    "Katuka",
    "Mazaza",
    "Zaki Town"
   ]
  }
 },
 "Bayelsa": {
  "capital": "Yenagoa",
  "cities": {
   "Brass": [
    "Akassa",
    "Ewoama",
    "Odioma",
    "Okpoama",
    "Sangana",
    "Twon-Brass"
   ],
   "Ekeremor": [
    "Aghoro",
    "Ekeremor Town",
    "Ikebiri",
    "Oweikorogha",
    "Tarakiri"
   ],
   "Kolokuma/Opokuma": [
    "Amassoma",
    "Ayama",
    "Kaiama",
    "Kolokuma",
    "Opokuma"
   ],
   "Nembe": [
    "Bassambiri",
    "Nembe Town",
    "Ogbolomabiri",
    "Okoroma"
   ],
   "Ogbia": [
    "Akipelai",
    "Anyama",
    "Kolo",
    "Ogbia Town",
    "Oloibiri",
    "Otuoke"
   ],
   "Sagbama": [
    "Agbere",
    "Mbiama",
    "Ofoni",
    "Sagbama Town",
    "Torugbene",
    "Tungbo"
   ],
   "Southern Ijaw": [
    "Amassoma",
    "Ikebiri",
    "Kolokolo",
    "Ogobiri",
    "Oporoma",
    "Ukubie"
   ],
   "Yenagoa": [
    "Epie",
    "Etegwe",
    "Kpansia",
    "Okaka",
    "Ovom",
    "Swali",
    "Yenagoa Town"
   ]
  }
 },
 "Benue": {
  "capital": "Makurdi",
  "cities": {
   "Ado": [
    "Ado Town",
    "Ekile",
    "Igumale",
    "Ogbilolo"
   ],
   "Agatu": [
    "Adagbo",
    "Aila",
    "Obagaji",
    "Okpagabi",
    "Ugboju"
   ],
   "Apa": [
    "Edikwu",
    "Iga Okpaya",
    "Oba Apa",
    "Ochekwu",
    "Ugbokpo"
   ],
   "Buruku": [
    "Binev",
    "Buruku Town",
    "Mbagen",
    "Mbaiwa",
    "Mbayion"
   ],
   "Gboko": [
    "Gboko Town",
    "Mbayegh",
    "Mkar",
    "Tse-Kucha",
    "Yandev"
   ],
   "Guma": [
    "Abinsi",
    "Gbajimba",
    "Mbalagh",
    "Nagi",
    "Yelwata"
   ],
   "Gwer East": [
    "Abagena",
    "Aliade",
    "Ikyoawen",
    "Tyodough",
    "Ukohol"
   ],
   "Gwer West": [
    "Agasha",
    "Mbakyaan",
    "Mbalom",
    "Naka",
    "Ugbema"
   ],
   "Katsina-Ala": [
    "Abwa",
    "Katsina-Ala Town",
    "Mbapa",
    "Mbawar",
    "Tse Adi"
   ],
   "Konshisha": [
    "Anyiin",
    "Awajir",
    "Mbawa",
    "Mbayongo",
    "Tse Adoo"
   ],
   "Kwande": [
    "Adikpo",
    "Jato Aka",
    "Mbatiav",
    "Tse Mbaikyor",
    "Turan"
   ],
   "Logo": [
    "Ahenayol",
    "Ayilamo",
    "Mbaakpur",
    "Tse Ahenayol",
    "Ugba"
   ],
   "Makurdi": [
    "Fiidi",
    "High Level",
    "Makurdi Town",
    "North Bank",
    "Wadata",
    "Wurukum"
   ],
   "Obi": [
    "Adum",
    "Ihugh",
    "Obarike-Ito",
    "Obi Town"
   ],
   "Ogbadibo": [
    "Itobe",
    "Ochekwu",
    "Orokam",
    "Otukpa",
    "Ugbokpo Ogbadibo"
   ],
   "Ohimini": [
    "Idekpa",
    "Ogbaulu",
    "Ohimini Town",
    "Okpe"
   ],
   "Oju": [
    "Adum East",
    "Itakpa",
    "Obuga",
    "Oju Town",
    "Ukpa"
   ],
   "Okpokwu": [
    "Ichama",
    "Ofute",
    "Okpoga",
    "Ugbokolo",
    "Ukwo"
   ],
   "Otukpo": [
    "Adoka",
    "Otobi",
    "Otukpo Town",
    "Ugbokolo Otukpo"
   ],
   "Tarka": [
    "Gbaamwe",
    "Mbaikpa",
    "Tarka Town",
    "Tse Kuri",
    "Wannune"
   ],
   "Ukum": [
    "Kumakwagh",
    "Sankera",
    "Tsar",
    "Ukum Town",
    "Zaki-Biam"
   ],
   "Ushongo": [
    "Lessel",
    "Mbaduku",
    "Mbayev",
    "Tarkighir",
    "Tse Gbaagber"
   ],
   "Vandeikya": [
    "Mbaakon",
    "Mbatsav",
    "Tiev",
    "Tse Mbaaior",
    "Vandeikya Town"
   ]
  }
 },
 "Borno": {
  "capital": "Maiduguri",
  "cities": {
   "Abadam": [
    "Abadam Town",
    "Kangarwa",
    "Malam Fatori"
   ],
   "Askira/Uba": [
    "Askira",
    "Mussa",
    "Uba",
    "Wamdeo"
   ],
   "Bama": [
    "Bama Town",
    "Banki",
    "Kasugula",
    "Mulgwe",
    "Soye"
   ],
   "Bayo": [
    "Bayo Town",
    "Briyel",
    "Kubo"
   ],
   "Biu": [
    "Biu Town",
    "Garubula",
    "Gurum",
    "Miringa"
   ],
   "Chibok": [
    "Chibok Town",
    "Kautikari",
    "Mbalala",
    "Pemi",
    "Thlaimakwa"
   ],
   "Damboa": [
    "Azir",
    "Dalwa",
    "Damboa Town",
    "Sabon Gari",
    "Wajiroko"
   ],
   "Dikwa": [
    "Ajiri",
    "Dikwa Town",
    "Waza"
   ],
   "Gubio": [
    "Gubio Town",
    "Kaska",
    "Yau",
    "Zowo"
   ],
   "Guzamala": [
    "Gajiganna",
    "Gudumbali",
    "Kareto",
    "Mbirim",
    "Wulgo"
   ],
   "Gwoza": [
    "Attagara",
    "Gwoza Town",
    "Lassa",
    "Ngoshe",
    "Pulka"
   ],
   "Hawul": [
    "Azare Hawul",
    "Hawul Town",
    "Marama",
    "Mbila",
    "Wuyaku"
   ],
   "Jere": [
    "Dalori",
    "Gongulong",
    "Khaddamari",
    "Mairi",
    "Molai",
    "Zabarmari"
   ],
   "Kaga": [
    "Benisheikh",
    "Dumbari",
    "Kaga Town",
    "Mashio",
    "Ngom"
   ],
   "Kala/Balge": [
    "Ala",
    "Balge",
    "Dabar Wanzam",
    "Kala",
    "Rann"
   ],
   "Konduga": [
    "Bale",
    "Dalori Two",
    "Kayamla",
    "Konduga Town"
   ],
   "Kukawa": [
    "Baga",
    "Doro",
    "Kangarwa",
    "Kukawa Town"
   ],
   "Kwaya Kusar": [
    "Kaiyamari",
    "Kwaya Kusar Town",
    "Shaffa"
   ],
   "Mafa": [
    "Kayamla",
    "Mafa Town",
    "Ngala Mafa"
   ],
   "Magumeri": [
    "Alau",
    "Jakana",
    "Kabir",
    "Mageri",
    "Magumeri Town"
   ],
   "Maiduguri": [
    "Bolori",
    "Gwange",
    "Maiduguri Metropolis",
    "Mashamari",
    "Old Maiduguri",
    "Shehuri"
   ],
   "Marte": [
    "Chingurmi",
    "Kekeno",
    "Kirenowa",
    "Marte Town"
   ],
   "Mobbar": [
    "Damasak",
    "Kangarwa",
    "Mobbar Town",
    "Ngwom",
    "Yaza"
   ],
   "Monguno": [
    "Gana Ali",
    "Malari",
    "Monguno Town"
   ],
   "Ngala": [
    "Dar Jamal",
    "Gamboru",
    "Ngala Town"
   ],
   "Nganzai": [
    "Gajiram",
    "Kaza",
    "Nganzai Town"
   ],
   "Shani": [
    "Lasaru",
    "Shani Town"
   ]
  }
 },
 "Cross River": {
  "capital": "Calabar",
  "cities": {
   "Abi": [
    "Ediba",
    "Itigidi",
    "Usumutong"
   ],
   "Akamkpa": [
    "Akamkpa Town",
    "Esuk Mba",
    "Mbarakom",
    "Oban",
    "Ukpon"
   ],
   "Akpabuyo": [
    "Ikot Edem Odo",
    "Ikot Eneobong",
    "Ikot Esop",
    "Ikot Nakanda"
   ],
   "Bakassi": [
    "Abana",
    "Akpa Okuti",
    "Archibong Town",
    "Atabong",
    "Ikang"
   ],
   "Bekwarra": [
    "Abuochiche",
    "Beten",
    "Gakem",
    "Ibiaragidi",
    "Ukpah"
   ],
   "Biase": [
    "Abini",
    "Akpet Central",
    "Aya",
    "Ibini",
    "Umon"
   ],
   "Boki": [
    "Boje",
    "Buentsebe",
    "Bumaji",
    "Nsadop",
    "Ofutop"
   ],
   "Calabar Municipal": [
    "Atimbo",
    "Big Qua",
    "Calabar Town",
    "Diamond Hill",
    "Ikot Ansa",
    "Marian"
   ],
   "Calabar South": [
    "Anantigha",
    "Efut",
    "Ekpo Abasi",
    "Ikot Omin",
    "Mount Zion",
    "Uwanse"
   ],
   "Etung": [
    "Agbokim",
    "Bendeghe",
    "Etomi",
    "Mbe",
    "Ofodua"
   ],
   "Ikom": [
    "Danare",
    "Ikom Town",
    "Nde",
    "Nkarasi",
    "Ofutop",
    "Okuni"
   ],
   "Obanliku": [
    "Bendi",
    "Bisu",
    "Butatong",
    "Obanliku Town",
    "Sankwala"
   ],
   "Obubra": [
    "Apiapum",
    "Iyamoyong",
    "Obubra Town",
    "Ochon",
    "Ofat"
   ],
   "Obudu": [
    "Begiaba",
    "Ipong",
    "Obudu Cattle Ranch",
    "Obudu Town",
    "Ukpe"
   ],
   "Odukpani": [
    "Adiabo",
    "Ediba Odukpani",
    "Eki Eki",
    "Ikot Ekpo",
    "Ito",
    "Odukpani Town"
   ],
   "Ogoja": [
    "Ekajuk",
    "Igoli",
    "Ishibori",
    "Nkim",
    "Ogoja Town"
   ],
   "Yakuur": [
    "Idomi",
    "Ijiman",
    "Mkpani",
    "Nko",
    "Ugep"
   ],
   "Yala": [
    "Ijiegu",
    "Ikot Yala",
    "Ntun",
    "Okuku",
    "Yala Town"
   ]
  }
 },
 "Delta": {
  "capital": "Asaba",
  "cities": {
   "Aniocha North": [
    "Issele-Uku",
    "Obior",
    "Onicha-Olona",
    "Ugboba"
   ],
   "Aniocha South": [
    "Aboh Aniocha",
    "Akwukwu-Igbo",
    "Obetim",
    "Ogwashi-Uku",
    "Ubulu-Uku"
   ],
   "Bomadi": [
    "Bomadi Town",
    "Koloware",
    "Kpakiama",
    "Ogriagbene",
    "Ogrinagbene"
   ],
   "Burutu": [
    "Ayakoromo",
    "Burutu Town",
    "Forcados",
    "Ogulagha",
    "Ojobo"
   ],
   "Ethiope East": [
    "Agbon",
    "Isiokolo",
    "Kokori",
    "Okpara-Inland"
   ],
   "Ethiope West": [
    "Jesse",
    "Mosogar",
    "Oghara",
    "Ologbo",
    "Ugbokpo"
   ],
   "Ika North East": [
    "Agbor",
    "Boji-Boji Agbor",
    "Ogbemudu",
    "Owa"
   ],
   "Ika South": [
    "Agbor",
    "Obiaruku",
    "Owa-Alidinma",
    "Umunede",
    "Ute-Okpu"
   ],
   "Isoko North": [
    "Emevor",
    "Irri",
    "Oleh",
    "Otor-Iyede",
    "Ozoro"
   ],
   "Isoko South": [
    "Emede",
    "Iyede",
    "Ofagbe",
    "Oleh",
    "Uzere"
   ],
   "Ndokwa East": [
    "Aboh",
    "Ashaka",
    "Ibrede",
    "Ogume",
    "Utchi"
   ],
   "Ndokwa West": [
    "Kwale",
    "Obiaruku",
    "Ogwuama",
    "Umuebu"
   ],
   "Okpe": [
    "Oha",
    "Okpe Town",
    "Orerokpe",
    "Uguanja"
   ],
   "Oshimili North": [
    "Akwukwu-Igbo",
    "Ibusa",
    "Ibusa Town",
    "Okpanam",
    "Ukala"
   ],
   "Oshimili South": [
    "Asaba",
    "Cable Point",
    "Ogbeokwe",
    "Oko",
    "Okwe"
   ],
   "Patani": [
    "Abari",
    "Ayakoromo",
    "Jaja",
    "Obotebe",
    "Patani Town"
   ],
   "Sapele": [
    "Amukpe",
    "Ogorode",
    "Okirigwe",
    "Sapele Town",
    "Ugolo"
   ],
   "Udu": [
    "Aladja",
    "Ekete",
    "Evwreni",
    "Otor-Udu",
    "Ovwian"
   ],
   "Ughelli North": [
    "Agbarho",
    "Evwreni",
    "Olomu",
    "Otu-Jeremi",
    "Ughelli"
   ],
   "Ughelli South": [
    "Ekiugbo",
    "Otu-Jeremi",
    "Ugbolokposo"
   ],
   "Ukwuani": [
    "Amai",
    "Ebedei",
    "Obiaruku",
    "Ukwuani Town",
    "Umutu"
   ],
   "Uvwie": [
    "Effurun",
    "Ekpan",
    "Enerhen",
    "Okuokoko",
    "Ugborikoko"
   ],
   "Warri North": [
    "Koko",
    "Ogbe-Ijoh",
    "Ogheye",
    "Ubeji",
    "Ugbuokpo"
   ],
   "Warri South": [
    "Jakpa",
    "Okere",
    "Okumagba",
    "Ubeji",
    "Ugbomro",
    "Warri"
   ],
   "Warri South West": [
    "Obaghoro",
    "Ode-Itsekiri",
    "Ogbe-Ijaw",
    "Ugbokan",
    "Ugborodo"
   ]
  }
 },
 "Ebonyi": {
  "capital": "Abakaliki",
  "cities": {
   "Abakaliki": [
    "Abakaliki Town",
    "Azugwu",
    "Ezzamgbo",
    "Kpirikpiri",
    "Ndiagu",
    "Nkaliki"
   ],
   "Afikpo North": [
    "Afikpo Town",
    "Amaizu",
    "Itim",
    "Nguzu Edda",
    "Ozizza"
   ],
   "Afikpo South": [
    "Amangbala",
    "Edda",
    "Nkpoghoro",
    "Okpoha",
    "Ugwuaji"
   ],
   "Ebonyi": [
    "Ezzagu",
    "Onueke",
    "Ugwulangwu"
   ],
   "Ezza North": [
    "Ebiaji",
    "Ekka",
    "Ezza-Effium",
    "Ogboji",
    "Omege"
   ],
   "Ezza South": [
    "Ezza-Ukwu",
    "Ezzamgbo",
    "Ngbo Ezza",
    "Nkomoro",
    "Okpoto"
   ],
   "Ikwo": [
    "Echara",
    "Ekpelu",
    "Ikwo Town",
    "Ndufu Echara",
    "Noyo"
   ],
   "Ishielu": [
    "Ezillo",
    "Ishielu Town",
    "Nkalagu",
    "Ntezi"
   ],
   "Ivo": [
    "Akaeze",
    "Ihetutu",
    "Ishiagu",
    "Ivo Town",
    "Oso"
   ],
   "Izzi": [
    "Ezza-Ihe",
    "Iboko",
    "Ndiegu",
    "Ndieze Izzi",
    "Ofoke"
   ],
   "Ohaozara": [
    "Obiozara",
    "Okposi",
    "Okue",
    "Uburu",
    "Ugwulangwu"
   ],
   "Ohaukwu": [
    "Effium",
    "Ekka",
    "Ezzamgbo Ohaukwu",
    "Ngbo",
    "Ohaukwu Town"
   ],
   "Onicha": [
    "Isu Onicha",
    "Okposi Onicha",
    "Onicha Town",
    "Ukawu"
   ]
  }
 },
 "Edo": {
  "capital": "Benin City",
  "cities": {
   "Akoko-Edo": [
    "Dagbala",
    "Ibillo",
    "Igarra",
    "Oja",
    "Ojirami",
    "Okpe"
   ],
   "Egor": [
    "Aduwawa",
    "Egor Town",
    "Ekosodin",
    "Evbotubu",
    "Ugbowo",
    "Uselu"
   ],
   "Esan Central": [
    "Ewohimi",
    "Irrua",
    "Ugbegun"
   ],
   "Esan North-East": [
    "Efandion",
    "Ekpon",
    "Ugboha",
    "Uromi"
   ],
   "Esan South-East": [
    "Ebelle",
    "Ewu",
    "Ubiaja",
    "Urohi"
   ],
   "Esan West": [
    "Ekpoma",
    "Emaudo",
    "Iyenlen",
    "Ogwa",
    "Ujemen"
   ],
   "Etsako Central": [
    "Agenebode",
    "Aviele",
    "Ayogwiri",
    "Fugar"
   ],
   "Etsako East": [
    "Agenebode",
    "Ekperi",
    "Iyora",
    "Okpella",
    "Weppa"
   ],
   "Etsako West": [
    "Auchi",
    "Aviele",
    "Iyakpi",
    "Jattu",
    "South Ibie"
   ],
   "Igueben": [
    "Amahor",
    "Ebhoiyi",
    "Ekpon",
    "Igueben",
    "Ugbegun"
   ],
   "Ikpoba Okha": [
    "Aduwawa",
    "Ekenwan",
    "Idogbo",
    "Ikpoba Hill",
    "Oluku"
   ],
   "Oredo": [
    "Benin City Centre",
    "GRA Benin",
    "Ugbekun"
   ],
   "Orhionmwon": [
    "Abudu",
    "Igbanke",
    "Okada",
    "Ugbogui",
    "Urhonigbe"
   ],
   "Ovia North-East": [
    "Iguobazuwa",
    "Okada",
    "Ora",
    "Siluko",
    "Udo",
    "Ugo"
   ],
   "Ovia South-West": [
    "Evbonekpen",
    "Iguoriakhi",
    "Ugbokun",
    "Utesi"
   ],
   "Owan East": [
    "Afuze",
    "Emai",
    "Otuo",
    "Ozalla",
    "Uzebba"
   ],
   "Owan West": [
    "Ighele",
    "Ora",
    "Sabongida-Ora",
    "Uokha",
    "Warake"
   ],
   "Uhunmwonde": [
    "Ehor",
    "Ihovbor",
    "Ugo"
   ]
  }
 },
 "Ekiti": {
  "capital": "Ado-Ekiti",
  "cities": {
   "Ado Ekiti": [
    "Adebayo",
    "Ado Ekiti Town",
    "Ajilosun",
    "Ilokun",
    "Irona",
    "Okesa"
   ],
   "Efon": [
    "Aaye",
    "Efon-Alaaye",
    "Ita Ogbolu"
   ],
   "Ekiti East": [
    "Aramoko",
    "Ayegbaju",
    "Isinbode",
    "Omuo-Ekiti"
   ],
   "Ekiti South-West": [
    "Igbara-Odo",
    "Ilawe-Ekiti",
    "Ipole",
    "Oke Ako",
    "Okemesi"
   ],
   "Ekiti West": [
    "Aramoko-Ekiti",
    "Erinmope",
    "Ikoro",
    "Ipoti",
    "Iyin-Ekiti"
   ],
   "Emure": [
    "Ebiri",
    "Emure-Ekiti",
    "Ipole",
    "Isaba",
    "Oke Alafia"
   ],
   "Gbonyin": [
    "Aisegba",
    "Ayetoro",
    "Ijesa Ekiti",
    "Ode-Ekiti",
    "Ogotun"
   ],
   "Ido Osi": [
    "Aaye",
    "Ido-Ekiti",
    "Ifaki",
    "Ilogbo",
    "Usi"
   ],
   "Ijero": [
    "Ejiyan",
    "Ijero-Ekiti",
    "Ilogbo",
    "Ipoti",
    "Ode"
   ],
   "Ikere": [
    "Ikere Town",
    "Ikere-Ekiti",
    "Ilawe",
    "Ise",
    "Orin"
   ],
   "Ikole": [
    "Ijesa-Isu",
    "Ikole-Ekiti",
    "Ipao",
    "Isinbode",
    "Oke Ako"
   ],
   "Ilejemeje": [
    "Ijesa Ekiti",
    "Ilemeje",
    "Iye-Ekiti",
    "Iyin"
   ],
   "Irepodun/Ifelodun": [
    "Afao",
    "Ajoni",
    "Araromi Opin",
    "Igede-Ekiti",
    "Ilumoba"
   ],
   "Ise/Orun": [
    "Ipele",
    "Ise-Ekiti",
    "Iyemero",
    "Orun-Ekiti"
   ],
   "Moba": [
    "Ilafon",
    "Ipao",
    "Oke-Ere",
    "Osan",
    "Otun-Ekiti"
   ],
   "Oye": [
    "Ayede",
    "Ibiye",
    "Ilupeju",
    "Isan",
    "Oye-Ekiti"
   ]
  }
 },
 "Enugu": {
  "capital": "Enugu",
  "cities": {
   "Aninri": [
    "Amagunze",
    "Awhum",
    "Isu-Aniocha",
    "Mgbowo",
    "Nenwe",
    "Oduma"
   ],
   "Awgu": [
    "Awgu Town",
    "Ihe",
    "Mgbidi",
    "Mmaku",
    "Obeagu",
    "Ugwueme"
   ],
   "Enugu East": [
    "Abakpa",
    "Emene",
    "Ngwo",
    "Nike",
    "Nkwubor",
    "Trans-Ekulu"
   ],
   "Enugu North": [
    "Asata",
    "GRA Enugu",
    "Independence Layout",
    "New Haven",
    "Ogui",
    "Uwani"
   ],
   "Enugu South": [
    "Akwuke",
    "Awkunanaw",
    "Ibagwa Enugu",
    "Obiagu",
    "Ogbete",
    "Uwani"
   ],
   "Ezeagu": [
    "Aguobu Owa",
    "Ihe Ezeagu",
    "Mgbowo",
    "Oghe",
    "Umumba Ndiagu"
   ],
   "Igbo Etiti": [
    "Igbo-Etiti Town",
    "Ogbede",
    "Ohodo",
    "Ukehe",
    "Umuopu"
   ],
   "Igbo Eze North": [
    "Enugu-Ezike",
    "Ette",
    "Ogurute",
    "Umunko"
   ],
   "Igbo Eze South": [
    "Ibagwa Aka",
    "Itchi",
    "Ohebe",
    "Ovoko",
    "Unadu"
   ],
   "Isi Uzo": [
    "Eha-Amufu",
    "Ikem",
    "Mbu",
    "Neke",
    "Umuitodo"
   ],
   "Nkanu East": [
    "Akpugo",
    "Amagunze",
    "Mpu",
    "Ugwuogo Nike"
   ],
   "Nkanu West": [
    "Agbani",
    "Akpugo",
    "Amechi Uwani",
    "Nara",
    "Ozalla"
   ],
   "Nsukka": [
    "Alor-Uno",
    "Edem",
    "Ibagwa Ani",
    "Nsukka Town",
    "Obukpa",
    "Opi"
   ],
   "Oji River": [
    "Achi",
    "Awlaw",
    "Inyi",
    "Oji River Town",
    "Ugwuoba"
   ],
   "Udenu": [
    "Ezimo",
    "Imilike",
    "Obollo-Afor",
    "Opanda",
    "Orba"
   ],
   "Udi": [
    "Abor",
    "Affa",
    "Nachi",
    "Ozalla",
    "Udi Town",
    "Ukana"
   ],
   "Uzo Uwani": [
    "Adani",
    "Ogurugu",
    "Ojor",
    "Opanda"
   ]
  }
 },
 "Federal Capital Territory": {
  "capital": "Abuja",
  "cities": {
   "Abaji": [
    "Abaji Town",
    "Agyana",
    "Gurdi",
    "Rimba Ebagi",
    "Yaba"
   ],
   "Abuja Municipal Area Council": [
    "Apo",
    "Asokoro",
    "Central Business District",
    "Durumi",
    "Dutse Alhaji",
    "Gaduwa",
    "Garki",
    "Gudu",
    "Gwarinpa",
    "Jabi",
    "Jahi",
    "Kado",
    "Karmo",
    "Katampe",
    "Life Camp",
    "Lugbe",
    "Mabushi",
    "Maitama",
    "Utako",
    "Wuse",
    "Wuse 2",
    "Wuye"
   ],
   "Bwari": [
    "Bwari Town",
    "Byazhin",
    "Dei-Dei",
    "Dutse Bwari",
    "Igu",
    "Kubwa",
    "Kuduru",
    "Mpape",
    "Ushafa",
    "Zuma"
   ],
   "Gwagwalada": [
    "Dobi",
    "Gwagwalada Town",
    "Ibwa",
    "Kutunku",
    "Paiko",
    "Tungan Maje",
    "Zuba"
   ],
   "Kuje": [
    "Chibiri",
    "Gaube",
    "Gwargwada",
    "Kabi",
    "Kuje Town",
    "Kujekwa",
    "Rubochi"
   ],
   "Kwali": [
    "Gwargwada Kwali",
    "Ketti",
    "Kilankwa",
    "Kwali Town",
    "Pandagi",
    "Yangoji"
   ]
  }
 },
 "Gombe": {
  "capital": "Gombe",
  "cities": {
   "Akko": [
    "Akko Town",
    "Gombe Abba",
    "Kumo",
    "Kuri",
    "Pindiga",
    "Tukulma"
   ],
   "Balanga": [
    "Balanga Town",
    "Bambam",
    "Dadin Kowa",
    "Swa",
    "Talasse",
    "Wala"
   ],
   "Billiri": [
    "Bangunji",
    "Billiri Town",
    "Gwandum",
    "Todi",
    "Tudu",
    "Wuro Tale"
   ],
   "Dukku": [
    "Dukku Town",
    "Hashidu",
    "Malam Sidi",
    "Wuro Jam",
    "Zange"
   ],
   "Funakaye": [
    "Bajoga",
    "Dukul",
    "Jillahi",
    "Kwarri",
    "Tongo"
   ],
   "Gombe": [
    "Bolari",
    "Gombe Town",
    "Jekadafari",
    "Nasarawo",
    "Pantami",
    "Tudun Wada"
   ],
   "Kaltungo": [
    "Ayaba",
    "Banganje",
    "Kalmai",
    "Kaltungo Town",
    "Tula"
   ],
   "Kwami": [
    "Gadam",
    "Komfulata",
    "Kwami Town",
    "Mallam Sidi"
   ],
   "Nafada": [
    "Barwo",
    "Birin Fulani",
    "Jigawa",
    "Nafada Town",
    "Shabewa"
   ],
   "Shongom": [
    "Boh",
    "Burak",
    "Filiya",
    "Lapan",
    "Shongom Town"
   ],
   "Yamaltu/Deba": [
    "Deba",
    "Difa",
    "Shinga",
    "Wade",
    "Yamaltu",
    "Zambuk"
   ]
  }
 },
 "Imo": {
  "capital": "Owerri",
  "cities": {
   "Aboh Mbaise": [
    "Aboh",
    "Afor Enyiogugu",
    "Nguru",
    "Oboama",
    "Umuagwo"
   ],
   "Ahiazu Mbaise": [
    "Ahiara",
    "Itu",
    "Obizi",
    "Oru Ahiara",
    "Uvuru"
   ],
   "Ehime Mbano": [
    "Ehime Town",
    "Ife",
    "Umuagwu",
    "Umuezeala"
   ],
   "Ezinihitte": [
    "Amakohia Mbaise",
    "Mbaise",
    "Nwekeukwu",
    "Onicha",
    "Oparanadim"
   ],
   "Ideato North": [
    "Aboh Ideato",
    "Amanze",
    "Isiekenesi",
    "Okwudor",
    "Ubahu"
   ],
   "Ideato South": [
    "Dikenafai",
    "Ezinifite Ideato",
    "Ihitte",
    "Isiala",
    "Umuhu"
   ],
   "Ihitte/Uboma": [
    "Amaigbo",
    "Amucha",
    "Ihitte Town",
    "Isinweke",
    "Lagwa"
   ],
   "Ikeduru": [
    "Amaimo",
    "Atta",
    "Avu",
    "Iho",
    "Ugirike"
   ],
   "Isiala Mbano": [
    "Amuzi",
    "Ezinachi",
    "Ogwa",
    "Umuelemai",
    "Uvuru Mbano"
   ],
   "Isu": [
    "Ihe",
    "Isu Town",
    "Okwuohia",
    "Umundugba",
    "Umuowa"
   ],
   "Mbaitoli": [
    "Eziama",
    "Ife Mbaitoli",
    "Nwaorieubi",
    "Oruoma",
    "Umuoma"
   ],
   "Ngor Okpala": [
    "Abacheke",
    "Ihitte Ngor",
    "Ngor Town",
    "Okpala",
    "Umuneke"
   ],
   "Njaba": [
    "Amaraku",
    "Nkwogwu",
    "Nnenasa",
    "Okwelle",
    "Umunumo"
   ],
   "Nkwerre": [
    "Ihitte Nkwerre",
    "Nkwerre Town",
    "Obiofor",
    "Okwe",
    "Oparanadim"
   ],
   "Nwangele": [
    "Amaigbo",
    "Ihitte Nwangele",
    "Nkume",
    "Nwangele Town",
    "Umunumo"
   ],
   "Obowo": [
    "Ihitte",
    "Obowo Town",
    "Okwe",
    "Okwelle",
    "Umuariam"
   ],
   "Oguta": [
    "Awo-Omamma",
    "Egbema",
    "Izombe",
    "Nkwesi",
    "Oguta Town"
   ],
   "Ohaji/Egbema": [
    "Awarra",
    "Egbema Town",
    "Mmahu",
    "Obiakpu",
    "Ohaji Town",
    "Umuapu"
   ],
   "Okigwe": [
    "Amaokwe",
    "Ihube",
    "Obinze",
    "Okigwe Town",
    "Okwe",
    "Umuowa"
   ],
   "Orlu": [
    "Amaifeke",
    "Eziama",
    "Ihioma",
    "Orlu Town",
    "Umudioka",
    "Umuna"
   ],
   "Orsu": [
    "Awo-Idemili",
    "Ihitte",
    "Orsu Town",
    "Umuoma"
   ],
   "Oru East": [
    "Akatta",
    "Awo-Omamma",
    "Mgbee",
    "Omuma"
   ],
   "Oru West": [
    "Ogbaku",
    "Okwelle",
    "Oru Town",
    "Umuawuchi"
   ],
   "Owerri Municipal": [
    "Aladinma",
    "Ama Ogbonna",
    "Douglas",
    "Ikenegbu",
    "Owerri Town",
    "World Bank"
   ],
   "Owerri North": [
    "Egbu",
    "Emekuku",
    "Naze",
    "Orie Uratta",
    "Ulakwo",
    "Umuguma"
   ],
   "Owerri West": [
    "Eziobodo",
    "Ihiagwa",
    "Nekede",
    "Obinze",
    "Ohii",
    "Umuguma"
   ],
   "Unuimo": [
    "Ihitte Unuimo",
    "Okwe",
    "Ubahu",
    "Umuaka",
    "Unuimo Town"
   ]
  }
 },
 "Jigawa": {
  "capital": "Dutse",
  "cities": {
   "Auyo": [
    "Auyo Town",
    "Ayan",
    "Gamsarka",
    "Tsidir",
    "Unik"
   ],
   "Babura": [
    "Babura Town",
    "Garu",
    "Gasakoli",
    "Kanya",
    "Maiyanka"
   ],
   "Biriniwa": [
    "Biriniwa Town",
    "Garun Gabas",
    "Kafin Gana",
    "Matamu",
    "Rafin Tsiga"
   ],
   "Birnin Kudu": [
    "Birnin Kudu Town",
    "Fandum",
    "Gantsa",
    "Kantoga",
    "Kiyayya"
   ],
   "Buji": [
    "Buji Town",
    "Dantsoho",
    "Kiyayya",
    "Kwaya",
    "Yalwawa"
   ],
   "Dutse": [
    "Dutse Town",
    "Fagoji",
    "Jigawar Tsada",
    "Kudai",
    "Limawa",
    "Takur"
   ],
   "Gagarawa": [
    "Gagarawa Town",
    "Gantsa",
    "Garko",
    "Kafin Gana"
   ],
   "Garki": [
    "Bargari",
    "Dundubus",
    "Garki Town"
   ],
   "Gumel": [
    "Gumel Town",
    "Isma",
    "Kwango",
    "Rimin Kebe"
   ],
   "Guri": [
    "Garin Dogo",
    "Guri Town",
    "Kafin Hausa",
    "Matarar",
    "Tsakuwa"
   ],
   "Gwaram": [
    "Basirka",
    "Dumus",
    "Gwaram Town",
    "Kanya",
    "Shuwarin"
   ],
   "Gwiwa": [
    "Dugwai",
    "Gwiwa Town",
    "Kwaya Gwiwa",
    "Yalleman"
   ],
   "Hadejia": [
    "Atafi",
    "Dubantu",
    "Hadejia Town",
    "Majema",
    "Matsango"
   ],
   "Jahun": [
    "Dundubus",
    "Gantsa Jahun",
    "Jahun Town",
    "Kanya"
   ],
   "Kafin Hausa": [
    "Dundubus",
    "Gari Dogo",
    "Kafin Hausa Town",
    "Kanya",
    "Tsakuwa"
   ],
   "Kaugama": [
    "Dudu",
    "Kafin Gana",
    "Kaugama Town",
    "Rinjin Kebe"
   ],
   "Kazaure": [
    "Gada",
    "Kazaure Town",
    "Zango"
   ],
   "Kiri Kasama": [
    "Garun Gabas",
    "Kafin Gana",
    "Katangi",
    "Kiri Kasama Town",
    "Yalleman"
   ],
   "Kiyawa": [
    "Fandum Kiyawa",
    "Gwarzo Kiyawa",
    "Katanga",
    "Kiyawa Town",
    "Yalo"
   ],
   "Maigatari": [
    "Dantsoho",
    "Dundubus",
    "Maigatari Town"
   ],
   "Malam Madori": [
    "Arewa",
    "Kafin Gana",
    "Malam Madori Town",
    "Tsakuwa"
   ],
   "Miga": [
    "Dumus",
    "Kafin Gana",
    "Miga Town"
   ],
   "Ringim": [
    "Gantsa",
    "Ringim Town",
    "Takur",
    "Zaure"
   ],
   "Roni": [
    "Dundubus",
    "Gamsarka",
    "Gantsa Roni",
    "Roni Town"
   ],
   "Sule Tankarkar": [
    "Dantsoho",
    "Gamsarka",
    "Kafin Gana",
    "Shuwarin",
    "Sule Tankarkar Town"
   ],
   "Taura": [
    "Dumus",
    "Gwarzo",
    "Taura Town",
    "Tsakuwa"
   ],
   "Yankwashi": [
    "Dundubus",
    "Gamsarka",
    "Yankwashi Town"
   ]
  }
 },
 "Kaduna": {
  "capital": "Kaduna",
  "cities": {
   "Birnin Gwari": [
    "Birnin Gwari Town",
    "Gwaska",
    "Kakangi",
    "Randagi",
    "Saulawa"
   ],
   "Chikun": [
    "Barnawa",
    "Kujama",
    "Narayi",
    "Rido",
    "Romi",
    "Sabon Tasha"
   ],
   "Giwa": [
    "Danmahawayi",
    "Gangara",
    "Giwa Town",
    "Shika",
    "Yakawada"
   ],
   "Igabi": [
    "Birnin Yero",
    "Kakau",
    "Kwarau",
    "Rigachikun",
    "Rigasa",
    "Turunku"
   ],
   "Ikara": [
    "Ikara Town",
    "Janruwa",
    "Kurmin Kogi",
    "Paki",
    "Saulawa"
   ],
   "Jaba": [
    "Ankpa",
    "Fada",
    "Kwoi",
    "Kwoi Town",
    "Nok"
   ],
   "Jema'a": [
    "Jagindi",
    "Kafanchan",
    "Kagoma",
    "Sabon Gari Kafanchan"
   ],
   "Kachia": [
    "Gumel",
    "Kachia Town",
    "Katari",
    "Kurmin Musa"
   ],
   "Kaduna North": [
    "Kaduna Central",
    "Kawo",
    "Malali",
    "Unguwar Rimi",
    "Unguwar Sarki"
   ],
   "Kaduna South": [
    "Badarawa",
    "Barnawa",
    "Kakuri",
    "Makera",
    "Sabon Gari Kaduna",
    "Television"
   ],
   "Kagarko": [
    "Dutsen Gaiya",
    "Jere",
    "Kagarko Town",
    "Katugal",
    "Kushe"
   ],
   "Kajuru": [
    "Buruku",
    "Idon",
    "Kajuru Town",
    "Kufana",
    "Rimau"
   ],
   "Kaura": [
    "Bondon",
    "Kaura Town",
    "Zonkwa"
   ],
   "Kauru": [
    "Kauru Town",
    "Kpaki",
    "Kwasa",
    "Kwoi Kauru",
    "Pambeguwa"
   ],
   "Kubau": [
    "Anchau",
    "Dutsen Wai",
    "Kubau Town",
    "Kwara",
    "Pambegua"
   ],
   "Kudan": [
    "Doka",
    "Hunkuyi",
    "Kudan Town",
    "Kurmin Gandu",
    "Zakari"
   ],
   "Lere": [
    "Garun Kurama",
    "Kwasau",
    "Lere Town",
    "Ribi",
    "Saminaka"
   ],
   "Makarfi": [
    "Gimi",
    "Makarfi Town",
    "Mallamawa",
    "Tashan Kudan",
    "Yanbawa"
   ],
   "Sabon Gari": [
    "Basawa",
    "Bomo",
    "Dogarawa",
    "Hanwa",
    "Muchia",
    "Sabon Gari Zaria"
   ],
   "Sanga": [
    "Fadan Kamantan",
    "Gwantu",
    "Kallah",
    "Sanga Town"
   ],
   "Soba": [
    "Dan Gamsu",
    "Garu",
    "Kofar Gayan",
    "Maigana",
    "Soba Town"
   ],
   "Zangon Kataf": [
    "Kurmin Masara",
    "Madakiya",
    "Zangon Kataf Town",
    "Zonkwa"
   ],
   "Zaria": [
    "Kofar Gayan",
    "Samaru",
    "Tudun Wada",
    "Zaria City",
    "Zaria Old City"
   ]
  }
 },
 "Kano": {
  "capital": "Kano",
  "cities": {
   "Ajingi": [
    "Ajingi Town",
    "Gafasa",
    "Gamawa",
    "Kachako",
    "Unguwar Kudu"
   ],
   "Albasu": [
    "Albasu Town",
    "Fajewa",
    "Gara",
    "Kafin Agur",
    "Yanbarau"
   ],
   "Bagwai": [
    "Bagwai Town",
    "Danwawu",
    "Kafin Agur",
    "Kiyawa Bagwai",
    "Wuro Bagga"
   ],
   "Bebeji": [
    "Bebeji Town",
    "Challawa",
    "Kofa",
    "Kuki",
    "Sarina"
   ],
   "Bichi": [
    "Bichi Town",
    "Danyaya",
    "Kwazarazaa",
    "Matan Fada",
    "Yalwa"
   ],
   "Bunkure": [
    "Barde",
    "Bunkure Town",
    "Gafan",
    "Kanwa"
   ],
   "Dala": [
    "Dala Hill",
    "Gobirawa",
    "Gwauron Dutse",
    "Kofar Mazugal",
    "Yalwa Dala"
   ],
   "Dambatta": [
    "Dambatta Town",
    "Gandun Albasa",
    "Kwarkwaro",
    "Ruwan Doruwa",
    "Zango"
   ],
   "Dawakin Kudu": [
    "Dawakin Kudu Town",
    "Kuka",
    "Kwalli",
    "Tsakuwa",
    "Zogarawa"
   ],
   "Dawakin Tofa": [
    "Dan Mari",
    "Dawakin Tofa Town",
    "Jar Kuka",
    "Kwanyawa",
    "Tomas"
   ],
   "Doguwa": [
    "Doguwa Town",
    "Kachi",
    "Kantudu",
    "Riruwai",
    "Tiga"
   ],
   "Fagge": [
    "Fagge Ta Kudu",
    "Fagge Town",
    "Gyadi-Gyadi",
    "Kwari Market",
    "Sabon Gari"
   ],
   "Gabasawa": [
    "Dabi",
    "Gabasawa Town",
    "Garun Gabas",
    "Kwanyawa",
    "Zaura"
   ],
   "Garko": [
    "Garko Town",
    "Gazobi",
    "Gurjiya",
    "Sarari",
    "Zogarawa"
   ],
   "Garun Mallam": [
    "Dungu",
    "Gangare",
    "Garun Mallam Town",
    "Kadawa",
    "Yantaba"
   ],
   "Gaya": [
    "Gamoji",
    "Gaya Town",
    "Kanwa",
    "Maimakawa"
   ],
   "Gezawa": [
    "Gezawa Town",
    "Jogana",
    "Kazaure",
    "Yan Kaba"
   ],
   "Gwale": [
    "Dorayi",
    "Gwale Town",
    "Kabuga",
    "Lungu",
    "Tudun Murtala"
   ],
   "Gwarzo": [
    "Gwarzo Town",
    "Jibawa",
    "Kadawa",
    "Kwarkwaro",
    "Sararin Gabas"
   ],
   "Kabo": [
    "Dugurawa",
    "Fanda",
    "Gadar",
    "Kabo Town",
    "Kwarkiya"
   ],
   "Kano Municipal": [
    "Gwammaja",
    "Hausawa",
    "Kano City",
    "Kofar Mata",
    "Kofar Nasarawa",
    "Sabuwar Gandu"
   ],
   "Karaye": [
    "Gwarmai",
    "Kafin Dafga",
    "Karaye Town",
    "Turawa"
   ],
   "Kibiya": [
    "Fumbaina",
    "Gwagwayi",
    "Kibiya Town",
    "Kwana",
    "Tarai"
   ],
   "Kiru": [
    "Dutsen Tanshi",
    "Kiru Town",
    "Maraku",
    "Tsamiya"
   ],
   "Kumbotso": [
    "Challawa",
    "Dan Maliki",
    "Kumbotso Town",
    "Kureken Sani",
    "Na'ibawa",
    "Panshekara"
   ],
   "Kunchi": [
    "Kunchi Town",
    "Kwarin Kwarya",
    "Wuro Tarpa"
   ],
   "Kura": [
    "Kadawa",
    "Karfi",
    "Kura Town",
    "Tudun Kwari"
   ],
   "Madobi": [
    "Dan Barde",
    "Kafin Ciyawa",
    "Madobi Town",
    "Rimin Zakara",
    "Tashar Yari"
   ],
   "Makoda": [
    "Chiromawa",
    "Dutsen Tanshi",
    "Makoda Town",
    "Tsakuwa"
   ],
   "Minjibir": [
    "Gandun Albasa",
    "Minjibir Town",
    "Nasarawa Minjibir",
    "Tsamiya"
   ],
   "Nasarawa": [
    "Dan Agundi",
    "Gama",
    "Hotoro",
    "Nasarawa Town",
    "Tudun Murtala",
    "Yan Dalla"
   ],
   "Rano": [
    "Dundubus",
    "Rano Town",
    "Tashar Kuka",
    "Zinyau"
   ],
   "Rimin Gado": [
    "Dan Rimi",
    "Rimin Gado Town",
    "Sarina"
   ],
   "Rogo": [
    "Chiromawa",
    "Falgore",
    "Kanwa",
    "Rogo Town",
    "Tsohuwar Rogo"
   ],
   "Shanono": [
    "Dugoru",
    "Kwarkiya",
    "Shanono Town",
    "Tsange"
   ],
   "Sumaila": [
    "Dandago",
    "Dangwauro",
    "Gala",
    "Rimin Sumaila",
    "Sumaila Town"
   ],
   "Takai": [
    "Kwarin Takai",
    "Takai Town",
    "Yarimawa"
   ],
   "Tarauni": [
    "Gyadi-Gyadi",
    "Hotoro South",
    "Ja'en",
    "Kurna",
    "Sharada",
    "Tarauni Town"
   ],
   "Tofa": [
    "Gandun Albasa",
    "Jama'a",
    "Tofa Town"
   ],
   "Tsanyawa": [
    "Dan Tsayi",
    "Gadar Gaya",
    "Tsanyawa Town"
   ],
   "Tudun Wada": [
    "Burum Burum",
    "Gwazaye",
    "Karefa",
    "Tudun Wada Town"
   ],
   "Ungogo": [
    "Gama Ungogo",
    "Panisau",
    "Rijiyar Zaki",
    "Ungogo Town"
   ],
   "Warawa": [
    "Dan Kunama",
    "Danlasan",
    "Imawa",
    "Ladduwa",
    "Warawa Town"
   ],
   "Wudil": [
    "Indabo",
    "Kwarin Wudil",
    "Wudil Town"
   ]
  }
 },
 "Katsina": {
  "capital": "Katsina",
  "cities": {
   "Bakori": [
    "Bakori Town",
    "Dabai",
    "Jarkuka",
    "Kurami",
    "Tsiga"
   ],
   "Batagarawa": [
    "Batagarawa Town",
    "Dankama",
    "Dawan Musa",
    "Kuka",
    "Yargoje"
   ],
   "Batsari": [
    "Batsari Town",
    "Dauran",
    "Gora",
    "Yar Gamji",
    "Zakka"
   ],
   "Baure": [
    "Baure Town",
    "Dankama",
    "Dumurkul",
    "Garu",
    "Sayaya"
   ],
   "Bindawa": [
    "Bindawa Town",
    "Gafiya",
    "Kuka",
    "Kuru"
   ],
   "Charanchi": [
    "Charanchi Town",
    "Ketare",
    "Kuka"
   ],
   "Dandume": [
    "Dabawa",
    "Dandume Town",
    "Gwarzo",
    "Kanya"
   ],
   "Danja": [
    "Danja Town",
    "Kanya"
   ],
   "Dan Musa": [
    "Dan Musa Town",
    "Kuka",
    "Yantumaki",
    "Yarkwaita"
   ],
   "Daura": [
    "Daura Town",
    "Gafiya"
   ],
   "Dutsi": [
    "Dutsi Town",
    "Wagini Kuka",
    "Yarkwaita"
   ],
   "Dutsin-Ma": [
    "Dutsin-Ma Town",
    "Kanya"
   ],
   "Faskari": [
    "Faskari Town",
    "Mairuwa",
    "Yankara"
   ],
   "Funtua": [
    "Funtua Town",
    "Maigamji"
   ],
   "Ingawa": [
    "Ingawa Town",
    "Tsiga"
   ],
   "Jibia": [
    "Dankoli",
    "Jibia Town"
   ],
   "Kafur": [
    "Dabawa",
    "Kafur Town",
    "Kanya Kafur",
    "Maigamji"
   ],
   "Kaita": [
    "Kaita Town",
    "Zango"
   ],
   "Kankara": [
    "Gora",
    "Kankara Town"
   ],
   "Kankia": [
    "Kankia Town",
    "Tsiga"
   ],
   "Katsina": [
    "Katsina City",
    "Kofar Durbi",
    "Kofar Guga",
    "Kofar Kaura",
    "Kofar Marusa",
    "Sabuwar Unguwa"
   ],
   "Kurfi": [
    "Kurfi Town"
   ],
   "Kusada": [
    "Kusada Town",
    "Zango"
   ],
   "Mai'Adua": [
    "Dumurkul",
    "Mai'Adua Town"
   ],
   "Malumfashi": [
    "Kanya Malumfashi",
    "Malumfashi Town"
   ],
   "Mani": [
    "Mani Town"
   ],
   "Mashi": [
    "Dumurkul",
    "Mashi Town"
   ],
   "Matazu": [
    "Matazu Town"
   ],
   "Musawa": [
    "Kanya Musawa",
    "Musawa Town"
   ],
   "Rimi": [
    "Rimi Town"
   ],
   "Sabuwa": [
    "Sabuwa Town"
   ],
   "Safana": [
    "Safana Town"
   ],
   "Sandamu": [
    "Sandamu Town"
   ],
   "Zango": [
    "Zango Town"
   ]
  }
 },
 "Kebbi": {
  "capital": "Birnin Kebbi",
  "cities": {
   "Aleiro": [
    "Aleiro Town"
   ],
   "Arewa Dandi": [
    "Arewa Dandi Town",
    "Kangiwa"
   ],
   "Argungu": [
    "Argungu Town",
    "Gulma",
    "Gwadangaji",
    "Kokani",
    "Sauwa"
   ],
   "Augie": [
    "Augie Town"
   ],
   "Bagudo": [
    "Bagudo Town",
    "Dole",
    "Kamba",
    "Kaoje",
    "Mashekari"
   ],
   "Birnin Kebbi": [
    "Birnin Kebbi Town",
    "Gwadangaji",
    "Makera",
    "Nassarawa",
    "Zauro"
   ],
   "Bunza": [
    "Bunza Town"
   ],
   "Dandi": [
    "Dandi Town",
    "Kamba"
   ],
   "Fakai": [
    "Fakai Town",
    "Ribah"
   ],
   "Gwandu": [
    "Gwandu Town"
   ],
   "Jega": [
    "Jega Town"
   ],
   "Kalgo": [
    "Kalgo Town"
   ],
   "Koko/Besse": [
    "Besse Town",
    "Koko Town"
   ],
   "Maiyama": [
    "Maiyama Town"
   ],
   "Ngaski": [
    "Ngaski Town",
    "Wara",
    "Warrah"
   ],
   "Sakaba": [
    "Sakaba Town"
   ],
   "Shanga": [
    "Shanga Town",
    "Wara"
   ],
   "Suru": [
    "Dakingari",
    "Suru Town"
   ],
   "Wasagu/Danko": [
    "Danko",
    "Ribah",
    "Wasagu"
   ],
   "Yauri": [
    "Yauri Town"
   ],
   "Zuru": [
    "Dabai",
    "Zuru Town"
   ]
  }
 },
 "Kogi": {
  "capital": "Lokoja",
  "cities": {
   "Adavi": [
    "Adavi Town",
    "Eika",
    "Obangede",
    "Ogaminana"
   ],
   "Ajaokuta": [
    "Ajaokuta Town",
    "Ganaja",
    "Itakpe",
    "Ugwolawo"
   ],
   "Ankpa": [
    "Ankpa Town",
    "Enjema",
    "Ichala",
    "Ogbogbo",
    "Ojoku"
   ],
   "Bassa": [
    "Abejukolo",
    "Bassa Town",
    "Iyale"
   ],
   "Dekina": [
    "Anyigba",
    "Dekina Town",
    "Ofugo",
    "Ojoku Dekina",
    "Okura"
   ],
   "Ibaji": [
    "Ejule",
    "Ibaji Town",
    "Ogbonyi",
    "Onyedega"
   ],
   "Idah": [
    "Idah Town",
    "Oguma"
   ],
   "Igalamela-Odolu": [
    "Ajaka",
    "Odolu"
   ],
   "Ijumu": [
    "Aiyetoro Gbede",
    "Ijumu Town",
    "Iyara",
    "Ogidi"
   ],
   "Kabba/Bunu": [
    "Aiyetoro Kiri",
    "Iyah",
    "Kabba",
    "Odo-Ere",
    "Ogidi Kabba"
   ],
   "Kogi": [
    "Gegu",
    "Kogi Town",
    "Koton Karfe"
   ],
   "Lokoja": [
    "Adankolo",
    "Felele",
    "Gadumo",
    "Ganaja",
    "Kabawa",
    "Lokoja Town"
   ],
   "Mopa-Muro": [
    "Aiyetoro Mopa",
    "Mopa",
    "Muro",
    "Ogidi Mopa"
   ],
   "Ofu": [
    "Aiyetoro Ofu",
    "Ofu Town",
    "Ugwolawo"
   ],
   "Ogori/Magongo": [
    "Magongo",
    "Ogori",
    "Ogori Town"
   ],
   "Okehi": [
    "Obehira",
    "Okehi Town"
   ],
   "Okene": [
    "Ageva",
    "Obeiba",
    "Okene Town",
    "Okengwe"
   ],
   "Olamaboro": [
    "Ife Olamaboro",
    "Okpoga",
    "Ugwolawo"
   ],
   "Omala": [
    "Abejukolo",
    "Omala Town"
   ],
   "Yagba East": [
    "Egbe",
    "Isanlu",
    "Isanlu Isin",
    "Odo Ere",
    "Ogbom"
   ],
   "Yagba West": [
    "Ayetoro Yagba",
    "Ejiba",
    "Odo Ere",
    "Yagba West Town"
   ]
  }
 },
 "Kwara": {
  "capital": "Ilorin",
  "cities": {
   "Asa": [
    "Aboto",
    "Afon",
    "Ajanaku",
    "Asa Town"
   ],
   "Baruten": [
    "Baruten Town",
    "Gwanara",
    "Kosubosu",
    "Okuta",
    "Yashikera"
   ],
   "Edu": [
    "Bokungi",
    "Edu Town",
    "Gbugudu",
    "Lafiagi",
    "Tsaragi"
   ],
   "Ekiti": [
    "Araromi Opin",
    "Ekiti Town"
   ],
   "Ifelodun": [
    "Ajase-Ipo",
    "Ifelodun Town",
    "Oke-Ode",
    "Share"
   ],
   "Ilorin East": [
    "Ilorin East Town",
    "Ita-Merin",
    "Ogidi Ilorin",
    "Oke-Ose",
    "Oke-Oyi"
   ],
   "Ilorin South": [
    "Fufu",
    "Gaa Akanbi",
    "Gaa Imam",
    "Ilorin South Town",
    "Oloje"
   ],
   "Ilorin West": [
    "Ilorin City",
    "Oja Oba",
    "Oke Oyi",
    "Pakata",
    "Sabo Oke",
    "Taiwo Isale"
   ],
   "Irepodun": [
    "Arandun",
    "Esie",
    "Igbaja",
    "Omu-Aran",
    "Oro"
   ],
   "Isin": [
    "Isin Town",
    "Oke-Onigbin",
    "Owa-Onire"
   ],
   "Kaiama": [
    "Banni",
    "Kaiama Town",
    "Kenu",
    "Sii"
   ],
   "Moro": [
    "Bode Saadu",
    "Lanwa",
    "Moro Town",
    "Shao"
   ],
   "Offa": [
    "Ikotun",
    "Offa Town",
    "Ojoku",
    "Oko"
   ],
   "Oke Ero": [
    "Ajase-Ipo",
    "Ero Ekiti",
    "Ilofa",
    "Oke Ero Town"
   ],
   "Oyun": [
    "Erin-Ile",
    "Ijagbo",
    "Ilemona",
    "Okerimi",
    "Oyun Town"
   ],
   "Pategi": [
    "Gbugudu",
    "Kpada",
    "Pategi Town",
    "Tsaragi"
   ]
  }
 },
 "Lagos": {
  "capital": "Ikeja",
  "cities": {
   "Agege": [
    "Agege Town",
    "Dopemu",
    "Isale Oja",
    "Oko Oba",
    "Orile Agege",
    "Pen Cinema"
   ],
   "Ajeromi-Ifelodun": [
    "Ajegunle",
    "Alaba Rago",
    "Boundary",
    "Layeni",
    "Olodi-Apapa",
    "Tolu"
   ],
   "Alimosho": [
    "Akowonjo",
    "Ayobo",
    "Egbe",
    "Egbeda",
    "Idimu",
    "Igando",
    "Ikotun",
    "Ipaja",
    "Isheri-Olofin",
    "Shasha"
   ],
   "Amuwo-Odofin": [
    "Abule Ado",
    "Agboju",
    "Amuwo",
    "Festac Town",
    "Mile 2",
    "Satellite Town"
   ],
   "Apapa": [
    "Apapa GRA",
    "Ijora",
    "Liverpool",
    "Marine Beach",
    "Tincan Island"
   ],
   "Badagry": [
    "Ajara",
    "Ajido",
    "Badagry Town",
    "Gbaji",
    "Iworo",
    "Topo"
   ],
   "Epe": [
    "Ejinrin",
    "Epe Town",
    "Eredo",
    "Itoikin",
    "Noforija",
    "Poka"
   ],
   "Eti-Osa": [
    "Ajah",
    "Banana Island",
    "Chevron",
    "Ikoyi",
    "Lekki Phase 1",
    "Oniru",
    "Victoria Island"
   ],
   "Ibeju-Lekki": [
    "Akodo",
    "Awoyaya",
    "Eleko",
    "Lekki Free Trade Zone",
    "Orimedu"
   ],
   "Ifako-Ijaiye": [
    "Agbado",
    "Alagbado",
    "Ifako",
    "Iju",
    "Ogba",
    "Ojokoro"
   ],
   "Ikeja": [
    "Alausa",
    "Allen Avenue",
    "Ikeja GRA",
    "Maryland",
    "Opebi",
    "Oregun"
   ],
   "Ikorodu": [
    "Igbogbo",
    "Ijede",
    "Ikorodu Town",
    "Imota",
    "Ita Elewa",
    "Majidun"
   ],
   "Kosofe": [
    "Agboyi",
    "Alapere",
    "Ketu",
    "Mile 12",
    "Ogudu",
    "Ojota"
   ],
   "Lagos Island": [
    "Idumota",
    "Isale Eko",
    "Lagos Island",
    "Obalende",
    "Onikan"
   ],
   "Lagos Mainland": [
    "Ebute-Metta",
    "Iddo",
    "Makoko",
    "Oyingbo",
    "Yaba"
   ],
   "Mushin": [
    "Idi-Araba",
    "Itire",
    "Mushin Town",
    "Ojuwoye",
    "Olorunsogo",
    "Papa Ajao"
   ],
   "Ojo": [
    "Alaba International",
    "Iba",
    "Igbede",
    "Ijegun",
    "Ojo Town",
    "Okokomaiko"
   ],
   "Oshodi-Isolo": [
    "Ejigbo",
    "Isolo",
    "Mafoluku",
    "Okota",
    "Oshodi"
   ],
   "Shomolu": [
    "Bariga",
    "Gbagada",
    "Onipanu",
    "Palmgrove",
    "Pedro",
    "Shomolu Town"
   ],
   "Surulere": [
    "Aguda",
    "Ijeshatedo",
    "Ikate",
    "Itire",
    "Lawanson",
    "Ojuelegba",
    "Surulere Town"
   ]
  }
 },
 "Nasarawa": {
  "capital": "Lafia",
  "cities": {
   "Akwanga": [
    "Akwanga Town",
    "Andaha",
    "Gudi",
    "Nunku"
   ],
   "Awe": [
    "Awe Town",
    "Azara",
    "Tunga"
   ],
   "Doma": [
    "Agwatashi",
    "Akpanaja",
    "Doma Town"
   ],
   "Karu": [
    "Gitata",
    "Karu Town",
    "Mararaba",
    "Masaka",
    "New Karu",
    "Uke"
   ],
   "Keana": [
    "Keana Town"
   ],
   "Keffi": [
    "Angwan Jaba",
    "Angwan Lambu",
    "Gishiri",
    "Keffi Town"
   ],
   "Kokona": [
    "Agyaragu",
    "Garaku",
    "Gitata",
    "Jenkwe",
    "Kokona Town"
   ],
   "Lafia": [
    "Bukan Sidi",
    "Lafia Central",
    "Lafia Town",
    "Shabu",
    "Wakwa"
   ],
   "Nasarawa": [
    "Loko",
    "Nasarawa Town",
    "Udege",
    "Ungwan Ado"
   ],
   "Nasarawa Egon": [
    "Nasarawa Egon Town"
   ],
   "Obi": [
    "Gudi",
    "Obi Town"
   ],
   "Toto": [
    "Gadabuke",
    "Toto Town",
    "Umaisha"
   ],
   "Wamba": [
    "Arum",
    "Wamba Town"
   ]
  }
 },
 "Niger": {
  "capital": "Minna",
  "cities": {
   "Agaie": [
    "Agaie Town",
    "Doko"
   ],
   "Agwara": [
    "Agwara Town"
   ],
   "Bida": [
    "Bida Town",
    "Wadata"
   ],
   "Borgu": [
    "Babanna",
    "Borgu Town",
    "New Bussa",
    "Wawa"
   ],
   "Bosso": [
    "Bosso Town",
    "Maikunkele"
   ],
   "Chanchaga": [
    "Dutsen Kura",
    "Kpakungu",
    "Maitumbi",
    "Minna Town",
    "Tunga"
   ],
   "Edati": [
    "Edati Town"
   ],
   "Gbako": [
    "Gbako Town",
    "Lemu"
   ],
   "Gurara": [
    "Gawu Babangida",
    "Gurara Town"
   ],
   "Katcha": [
    "Katcha Town"
   ],
   "Kontagora": [
    "Kontagora Town"
   ],
   "Lapai": [
    "Gulu",
    "Lapai Town"
   ],
   "Lavun": [
    "Kutigi",
    "Lavun Town"
   ],
   "Magama": [
    "Magama Town",
    "Nasko"
   ],
   "Mariga": [
    "Bangi",
    "Mariga Town"
   ],
   "Mashegu": [
    "Mashegu Town"
   ],
   "Mokwa": [
    "Mokwa Town",
    "Muregi"
   ],
   "Moya": [
    "Moya Town"
   ],
   "Paikoro": [
    "Paiko",
    "Paikoro Town"
   ],
   "Rafi": [
    "Kagara",
    "Rafi Town",
    "Tegina"
   ],
   "Rijau": [
    "Rijau Town"
   ],
   "Shiroro": [
    "Allawa",
    "Galkogo",
    "Gussoro",
    "Kuta",
    "Shiroro Town"
   ],
   "Suleja": [
    "Madalla",
    "Suleja Town"
   ],
   "Tafa": [
    "Dutsen Kura",
    "Tafa Town",
    "Wuse"
   ],
   "Wushishi": [
    "Wushishi Town"
   ]
  }
 },
 "Ogun": {
  "capital": "Abeokuta",
  "cities": {
   "Abeokuta North": [
    "Ake",
    "Isale Igbein",
    "Ita Oshin",
    "Kuto",
    "Lafenwa",
    "Oke-Ona"
   ],
   "Abeokuta South": [
    "Adatan",
    "Ibara",
    "Idi Aba",
    "Oke Mosan",
    "Panseke",
    "Sapon"
   ],
   "Ado-Odo/Ota": [
    "Ado-Odo",
    "Agbara",
    "Ijoko",
    "Ilogbo",
    "Iyana-Iyesi",
    "Ota",
    "Sango Ota"
   ],
   "Ewekoro": [
    "Elere",
    "Ewekoro Town",
    "Ifo Ewekoro",
    "Itori",
    "Papalanto",
    "Wasimi"
   ],
   "Ifo": [
    "Agbado",
    "Ajuwon",
    "Akute",
    "Coker",
    "Ifo Town",
    "Ojodu Berger"
   ],
   "Ijebu East": [
    "Ajebandele",
    "Ijebu Mushin",
    "Imushin",
    "Itele Ijebu",
    "Ogbere"
   ],
   "Ijebu North": [
    "Ago Iwoye",
    "Awa",
    "Ijebu Igbo",
    "Ilaporu",
    "Ojowo",
    "Oru"
   ],
   "Ijebu North East": [
    "Atan",
    "Ijebu Itele",
    "Ilese",
    "Ogbere Ijebu",
    "Oke Agbo"
   ],
   "Ijebu Ode": [
    "Folagbade",
    "Ijagba",
    "Ijasi",
    "Ijebu Ode Town",
    "Itamapako",
    "Oke Sopen"
   ],
   "Ikenne": [
    "Ikenne Town",
    "Ilisan",
    "Ilishan-Remo",
    "Iperu",
    "Irolu",
    "Ogere"
   ],
   "Imeko Afon": [
    "Afon",
    "Idofa",
    "Ilara",
    "Imeko",
    "Iwoye",
    "Kajola"
   ],
   "Ipokia": [
    "Ajegunle Ipokia",
    "Idiroko",
    "Ifonyintedo",
    "Ihunbo",
    "Ipokia Town",
    "Maun"
   ],
   "Obafemi Owode": [
    "Ibafo",
    "Kobape",
    "Mowe",
    "Obafemi",
    "Ofada",
    "Owode"
   ],
   "Odeda": [
    "Alabata",
    "Ilugun",
    "Obantoko",
    "Odeda Town",
    "Olodo",
    "Opeji"
   ],
   "Odogbolu": [
    "Ala",
    "Ijebu Mushin",
    "Ilapo",
    "Odogbolu Town",
    "Okun-Owa"
   ],
   "Ogun Waterside": [
    "Abigi",
    "Ayila",
    "Ibiade",
    "Iwopin",
    "Makun",
    "Ogunmakin"
   ],
   "Remo North": [
    "Ilara",
    "Ipara",
    "Iraye",
    "Isara",
    "Ode-Remo"
   ],
   "Sagamu": [
    "Ijagba Sagamu",
    "Makun",
    "Ode-Lemo",
    "Ode-Remo",
    "Ogijo",
    "Sagamu Town"
   ],
   "Yewa North": [
    "Ayetoro",
    "Ibese",
    "Igan Alade",
    "Joga Orile"
   ],
   "Yewa South": [
    "Ijanna",
    "Ilaro",
    "Ilaro Town",
    "Oja Odan",
    "Owode Yewa"
   ]
  }
 },
 "Ondo": {
  "capital": "Akure",
  "cities": {
   "Akoko North-East": [
    "Ikaramu",
    "Ikare",
    "Ipe",
    "Irun",
    "Ogbagi"
   ],
   "Akoko North-West": [
    "Ayegunle",
    "Gedegede",
    "Ogbagi",
    "Okeagbe",
    "Oyin"
   ],
   "Akoko South-East": [
    "Epinmi",
    "Ipe Akoko",
    "Isua",
    "Iyani",
    "Ogbagi"
   ],
   "Akoko South-West": [
    "Akungba",
    "Ibaramu",
    "Ikun",
    "Oba-Akoko",
    "Oka"
   ],
   "Akure North": [
    "Igbaraoke",
    "Iju",
    "Ita-Ogbolu",
    "Iwaro-Oka",
    "Owena"
   ],
   "Akure South": [
    "Akure Town",
    "Alagbaka",
    "Ijapo",
    "Ilesha Garage",
    "Oba-Ile",
    "Oke-Aro"
   ],
   "Ese Odo": [
    "Aiyetoro",
    "Ayetoro",
    "Eseodo",
    "Igbekebo",
    "Ugbonla"
   ],
   "Idanre": [
    "Atosin",
    "Idanre Town",
    "Ode-Aye",
    "Owena"
   ],
   "Ifedore": [
    "Ifedore Town",
    "Ifira",
    "Igbara-Oke",
    "Ijare",
    "Ilara-Mokin"
   ],
   "Ilaje": [
    "Aiyetoro Ilaje",
    "Awoye",
    "Ayetoro",
    "Igbokoda",
    "Mahin",
    "Ode-Ugbo"
   ],
   "Ile Oluji/Okeigbo": [
    "Ifon",
    "Ile Oluji",
    "Irele",
    "Oke-Igbo Town",
    "Okeigbo"
   ],
   "Irele": [
    "Ayeka",
    "Ibuji",
    "Ijuoloja",
    "Ikoya",
    "Ode-Irele"
   ],
   "Odigbo": [
    "Ago-Alaye",
    "Ibuji Odigbo",
    "Ijare",
    "Ode-Aye",
    "Ore"
   ],
   "Okitipupa": [
    "Erinje",
    "Igbotako",
    "Ilutitun",
    "Ode-Aye",
    "Okitipupa Town"
   ],
   "Ondo East": [
    "Ayeka",
    "Bolorunduro",
    "Ojurin",
    "Oke-Odo",
    "Ondo East Town"
   ],
   "Ondo West": [
    "Odojomu",
    "Ondo Town",
    "Sabo Ondo",
    "Yaba"
   ],
   "Ose": [
    "Ido-Ani",
    "Ifon",
    "Imeri",
    "Ose Town",
    "Ute"
   ],
   "Owo": [
    "Emure Owo",
    "Ijebu-Owo",
    "Isuada",
    "Ogbese",
    "Owo Town"
   ]
  }
 },
 "Osun": {
  "capital": "Osogbo",
  "cities": {
   "Atakunmosa East": [
    "Atakunmosa East Town",
    "Ibodi",
    "Iperindo",
    "Iwara"
   ],
   "Atakunmosa West": [
    "Atakunmosa West Town",
    "Ijeda",
    "Iwara",
    "Osu"
   ],
   "Aiyedaade": [
    "Awo",
    "Gbongan",
    "Ikire"
   ],
   "Aiyedire": [
    "Aiyedire Town",
    "Awo",
    "Ile Ogbo"
   ],
   "Boluwaduro": [
    "Boluwaduro Town",
    "Ijebu Jesa",
    "Okuku",
    "Otan Ayegbaju"
   ],
   "Boripe": [
    "Boripe Town",
    "Ikirun",
    "Iragbiji",
    "Ora Igbomina"
   ],
   "Ede North": [
    "Awo",
    "Ede North Town",
    "Ede Town",
    "Oke Gada",
    "Oluode"
   ],
   "Ede South": [
    "Ede",
    "Ede South Town",
    "Ileogbo",
    "Oke Ayepe",
    "Oluode Ede"
   ],
   "Egbedore": [
    "Awo",
    "Egbedore Town"
   ],
   "Ejigbo": [
    "Ejigbo Central",
    "Ejigbo Town",
    "Oke Eso"
   ],
   "Ife Central": [
    "Ife Central Town",
    "Ile-Ife",
    "Obafemi Awolowo University",
    "Oranmiyan"
   ],
   "Ife East": [
    "Ife East Town",
    "Modakeke",
    "Moore",
    "Oke Ogbo"
   ],
   "Ife North": [
    "Akinlalu",
    "Asipa",
    "Edun Abon",
    "Ife North Town",
    "Ipetumodu"
   ],
   "Ife South": [
    "Ife South Town",
    "Ifetedo",
    "Oke Ila"
   ],
   "Ifedayo": [
    "Ifedayo Town",
    "Ila Orangun",
    "Oke Ila"
   ],
   "Ifelodun": [
    "Ifelodun Town",
    "Ikirun",
    "Ora"
   ],
   "Ila": [
    "Ila Orangun",
    "Ila Town",
    "Ora Igbomina"
   ],
   "Ilesa East": [
    "Ijeda",
    "Ilesa East Town",
    "Ilesa Town"
   ],
   "Ilesa West": [
    "Ijeda",
    "Ilesa West Town",
    "Iwara",
    "Osu"
   ],
   "Irepodun": [
    "Ilobu",
    "Irepodun Town"
   ],
   "Irewole": [
    "Ikire",
    "Irewole Town"
   ],
   "Isokan": [
    "Apomu",
    "Isokan Town"
   ],
   "Iwo": [
    "Iwo Central",
    "Iwo Town",
    "Oke Oba",
    "Oluwo Compound"
   ],
   "Obokun": [
    "Ibokun",
    "Ijebu Jesa",
    "Obokun Town"
   ],
   "Odo Otin": [
    "Odo Otin Town",
    "Okuku"
   ],
   "Ola Oluwa": [
    "Bode Osi",
    "Ola Oluwa Town"
   ],
   "Olorunda": [
    "Igbonna",
    "Olorunda Town"
   ],
   "Oriade": [
    "Ijebu Jesa",
    "Oriade Town"
   ],
   "Orolu": [
    "Ifon Orolu",
    "Orolu Town"
   ],
   "Osogbo": [
    "Alekuwodo",
    "Dugbe",
    "Oja Oba",
    "Oke Fia",
    "Osogbo Town",
    "Ota Efun"
   ]
  }
 },
 "Oyo": {
  "capital": "Ibadan",
  "cities": {
   "Afijio": [
    "Fiditi",
    "Ilora",
    "Iware",
    "Jobele"
   ],
   "Akinyele": [
    "Ajibode",
    "Akinyele Town",
    "Ikereku",
    "Iroko",
    "Moniya",
    "Olodo"
   ],
   "Atiba": [
    "Atiba Town",
    "Ilora",
    "Ipapo",
    "Ofa Meta",
    "Oke Ado",
    "Oyo Town"
   ],
   "Atisbo": [
    "Ago-Are",
    "Atisbo Town",
    "Tede"
   ],
   "Egbeda": [
    "Akanran",
    "Alakia",
    "Egbeda Town",
    "Erunmu",
    "Olodo",
    "Ologuneru"
   ],
   "Ibadan North": [
    "Agodi",
    "Bodija",
    "Ojoo",
    "Samonda",
    "Sango",
    "University of Ibadan"
   ],
   "Ibadan North-East": [
    "Ayeye",
    "Oje",
    "Oranyan"
   ],
   "Ibadan North-West": [
    "Alafara",
    "Dugbe",
    "Eleyele",
    "Oke Ado"
   ],
   "Ibadan South-East": [
    "Mapo",
    "Mokola",
    "Odinjo",
    "Oke Bola",
    "Oke Offa",
    "Oranyan"
   ],
   "Ibadan South-West": [
    "Bashorun",
    "Challenge",
    "Jericho",
    "Oluyole"
   ],
   "Ibarapa Central": [
    "Ibarapa Central Town",
    "Idere",
    "Igbo-Ora",
    "Tapa"
   ],
   "Ibarapa East": [
    "Ayete",
    "Eruwa",
    "Ibarapa East Town",
    "Idere",
    "Lanlate"
   ],
   "Ibarapa North": [
    "Ayete",
    "Ibarapa North Town",
    "Igangan",
    "Igbo-Ora",
    "Tapa"
   ],
   "Ido": [
    "Apata",
    "Ido Ibadan",
    "Ido Town",
    "Omi Adio"
   ],
   "Irepo": [
    "Iganna",
    "Igbeti",
    "Irepo Town",
    "Kishi"
   ],
   "Iseyin": [
    "Ago Are",
    "Ilero",
    "Iseyin Central",
    "Iseyin North",
    "Iseyin Town"
   ],
   "Itesiwaju": [
    "Ago-Are",
    "Iganna",
    "Itesiwaju Town",
    "Kisi",
    "Otu"
   ],
   "Iwajowa": [
    "Ago-Are",
    "Igbeti",
    "Iwajowa Town",
    "Iwere-Ile",
    "Kisi"
   ],
   "Kajola": [
    "Ago Are",
    "Kajola Town",
    "Okeho"
   ],
   "Lagelu": [
    "Akanran",
    "Iyana Church",
    "Lagelu Town"
   ],
   "Ogbomosho North": [
    "Isale Afon",
    "Ogbomosho North Town",
    "Ogbomoso",
    "Oja Igbo"
   ],
   "Ogbomosho South": [
    "Arowomole",
    "Isale Afon",
    "Ogbomosho South Town",
    "Oja Igbo"
   ],
   "Ogo Oluwa": [
    "Ajaawa",
    "Ajawa",
    "Igbo-Ora",
    "Ogo Oluwa Town"
   ],
   "Olorunsogo": [
    "Igbeti",
    "Irepo",
    "Kishi",
    "Olorunsogo Town"
   ],
   "Oluyole": [
    "Idi Ayunre",
    "Oluyole Town"
   ],
   "Ona Ara": [
    "Akanran",
    "Ona Ara Town"
   ],
   "Orelope": [
    "Ago-Are",
    "Iganna",
    "Igboho",
    "Kishi",
    "Orelope Town"
   ],
   "Ori Ire": [
    "Ikoyi-Ile",
    "Ori Ire Town"
   ],
   "Oyo": [
    "Awe",
    "Fiditi",
    "Ilora",
    "Ofa Meta",
    "Oyo Town",
    "Oyo West"
   ],
   "Oyo East": [
    "Kosobo",
    "Oyo East Town"
   ],
   "Saki East": [
    "Ago-Are",
    "Agoamodu",
    "Iganna",
    "Saki East Town"
   ],
   "Saki West": [
    "Ago-Are",
    "Iganna",
    "Kishi",
    "Saki Town",
    "Saki West Town"
   ],
   "Surulere": [
    "Iresa-Adu",
    "Surulere Town"
   ]
  }
 },
 "Plateau": {
  "capital": "Jos",
  "cities": {
   "Barkin Ladi": [
    "Barkin Ladi Town",
    "Foron",
    "Gashish",
    "Heipang",
    "Kuru Karama",
    "Ropp"
   ],
   "Bassa": [
    "Bassa Town",
    "Irigwe",
    "Miango",
    "Rafiki"
   ],
   "Bokkos": [
    "Bokkos Town",
    "Daffo",
    "Manguna",
    "Mushere",
    "Richa"
   ],
   "Jos East": [
    "Angware",
    "Fobur",
    "Gyel",
    "Ibi",
    "Jos East Town",
    "Maijuju"
   ],
   "Jos North": [
    "Angwan Rogo",
    "Gada Biyu",
    "Jos City",
    "Rayfield",
    "Tudun Wada"
   ],
   "Jos South": [
    "Bukuru",
    "Du",
    "Gyel",
    "Heipang",
    "Kwata",
    "Vom"
   ],
   "Kanam": [
    "Dengi",
    "Gar",
    "Kanam Town"
   ],
   "Kanke": [
    "Kanke Town",
    "Kwande",
    "Tudun Wada"
   ],
   "Langtang North": [
    "Gazum",
    "Langtang",
    "Langtang North Town",
    "Mabudi"
   ],
   "Langtang South": [
    "Gazum",
    "Langtang South Town",
    "Mabudi"
   ],
   "Mangu": [
    "Chakfem",
    "Chanso",
    "Mangu Halle",
    "Mangu Town",
    "Pushit"
   ],
   "Mikang": [
    "Gindiri",
    "Kwa",
    "Mikang Halle",
    "Mikang Town"
   ],
   "Pankshin": [
    "Chip",
    "Dengi",
    "Kwa",
    "Pankshin Halle",
    "Pankshin Town"
   ],
   "Qua'an Pan": [
    "Namu",
    "Qua'an Pan Town"
   ],
   "Riyom": [
    "Jol",
    "Kwi",
    "Rim",
    "Riyom Hill",
    "Riyom Town"
   ],
   "Shendam": [
    "Kwande",
    "Shendam Town"
   ],
   "Wase": [
    "Dengi",
    "Wase Halle",
    "Wase Town"
   ]
  }
 },
 "Rivers": {
  "capital": "Port Harcourt",
  "cities": {
   "Abua/Odual": [
    "Abua",
    "Odual",
    "Ogbakiri",
    "Ogbogoro",
    "Okpofe"
   ],
   "Ahoada East": [
    "Ahoada",
    "Ahoada East Town",
    "Ula Ikata",
    "Ula-Upata"
   ],
   "Ahoada West": [
    "Ahoada West Town",
    "Akinima",
    "Ihuoma",
    "Ogbo",
    "Ula Ikata"
   ],
   "Akuku-Toru": [
    "Abonnema",
    "Abuloma",
    "Idama",
    "Ido",
    "Obonoma"
   ],
   "Andoni": [
    "Ataba",
    "Ikuru",
    "Ngo",
    "Ohia",
    "Unyeada"
   ],
   "Asari-Toru": [
    "Abonema",
    "Buguma",
    "Ibuloma",
    "Ido Town"
   ],
   "Bonny": [
    "Abalamabie",
    "Ayambo",
    "Bonny Town",
    "Finima"
   ],
   "Degema": [
    "Abonema",
    "Bukuma",
    "Degema Town",
    "Obuama",
    "Tombia"
   ],
   "Eleme": [
    "Agbonchia",
    "Alesa",
    "Aleto",
    "Ebubu",
    "Ogale",
    "Ogoloma"
   ],
   "Emuoha": [
    "Egwi",
    "Elele Alimini",
    "Emuoha Town",
    "Ibaa",
    "Rumuji"
   ],
   "Etche": [
    "Chokocho",
    "Etche Town",
    "Igbodo",
    "Odufor",
    "Okehi"
   ],
   "Gokana": [
    "Barako",
    "Bodo",
    "Bomu",
    "Gokana Town",
    "Kpor"
   ],
   "Ikwerre": [
    "Igwuruta",
    "Ikwerre Town",
    "Isiokpo",
    "Omagwa",
    "Omerelu"
   ],
   "Khana": [
    "Bori",
    "Khana Town",
    "Kono",
    "Kpean",
    "Ogoni Town"
   ],
   "Obio/Akpor": [
    "Choba",
    "Rukpokwu",
    "Rumuigbo",
    "Rumuokoro",
    "Rumuokwuta",
    "Rumuola"
   ],
   "Ogba/Egbema/Ndoni": [
    "Egbema Town",
    "Ndoni",
    "Obite",
    "Ogba Town",
    "Omoku"
   ],
   "Ogu/Bolo": [
    "Bolo",
    "Bolo Town",
    "Ogu",
    "Ogu Town"
   ],
   "Okrika": [
    "Abuloma",
    "Kalio",
    "Ogbogu",
    "Ogoloma",
    "Okrika Town"
   ],
   "Omuma": [
    "Akpoku",
    "Eberi",
    "Omuma Town",
    "Uvuru"
   ],
   "Opobo/Nkoro": [
    "Ayama",
    "Iwoma",
    "Kalaibiama",
    "Nkoro",
    "Opobo Town"
   ],
   "Oyigbo": [
    "Afam",
    "Komkom",
    "Obete",
    "Ogbogu Oyigbo",
    "Oyigbo Town"
   ],
   "Port Harcourt": [
    "Borokiri",
    "Diobu",
    "GRA Phase 1",
    "Old GRA",
    "Port Harcourt City",
    "Rumuomasi"
   ],
   "Tai": [
    "Botem",
    "Kpite",
    "Nonwa",
    "Sime",
    "Tai Town"
   ]
  }
 },
 "Sokoto": {
  "capital": "Sokoto",
  "cities": {
   "Binji": [
    "Binji Town"
   ],
   "Bodinga": [
    "Bodinga Town",
    "Danchadi",
    "Kwanawa"
   ],
   "Dange Shuni": [
    "Dange",
    "Dange Town",
    "Kasarawa",
    "Shuni",
    "Tudun Wada"
   ],
   "Gada": [
    "Gada Town",
    "Kaura",
    "Rakumi",
    "Tsitse"
   ],
   "Goronyo": [
    "Daddara",
    "Goronyo Town",
    "Kwarma",
    "Shinaka"
   ],
   "Gudu": [
    "Balle",
    "Gudu Town",
    "Kanwa",
    "Kaurar Sarkin",
    "Tara"
   ],
   "Gwadabawa": [
    "Gwadabawa Town",
    "Kurawa",
    "Kuruwa"
   ],
   "Illela": [
    "Illela Town",
    "Kwarare",
    "Tsamaye"
   ],
   "Isa": [
    "Isa Town",
    "Kamarawa",
    "Tsabre"
   ],
   "Kebbe": [
    "Dabagi",
    "Kebbe Town"
   ],
   "Kware": [
    "Dole",
    "Kware Town"
   ],
   "Rabah": [
    "Dan Wuri",
    "Kurya",
    "Mara",
    "Rabah Town"
   ],
   "Sabon Birni": [
    "Gatawa",
    "Kurawa",
    "Lajawa",
    "Sabon Birni Town",
    "Tsamaye"
   ],
   "Shagari": [
    "Dandin Mahe",
    "Kwarkiya",
    "Shagari Town"
   ],
   "Silame": [
    "Dan Kurmi",
    "Katami",
    "Silame Town"
   ],
   "Sokoto North": [
    "Dundaye",
    "Kofar Atiku",
    "Kofar Rini",
    "Sokoto City",
    "Tudun Wada"
   ],
   "Sokoto South": [
    "Gawon Nama",
    "Gwiwa",
    "Mabera",
    "Runjin Sambo",
    "Sokoto South Town"
   ],
   "Tambuwal": [
    "Jabo",
    "Tambuwal Town"
   ],
   "Tangaza": [
    "Tangaza Town"
   ],
   "Tureta": [
    "Tureta Town"
   ],
   "Wamako": [
    "Tudun Wada",
    "Wamako Town"
   ],
   "Wurno": [
    "Wurno Town"
   ],
   "Yabo": [
    "Yabo Town"
   ]
  }
 },
 "Taraba": {
  "capital": "Jalingo",
  "cities": {
   "Ardo Kola": [
    "Ardo Kola Town",
    "Kpantisawa"
   ],
   "Bali": [
    "Bali Town",
    "Gyawana",
    "Mayo Ranewo",
    "Suntai"
   ],
   "Donga": [
    "Donga Town",
    "Sabon Gida"
   ],
   "Gashaka": [
    "Gashaka Town",
    "Mayo Selbe",
    "Sarkin Dawa",
    "Serti"
   ],
   "Gassol": [
    "Bantaje",
    "Gassol Town",
    "Mutum Biyu"
   ],
   "Ibi": [
    "Bantaje",
    "Ibi Town"
   ],
   "Jalingo": [
    "Barade",
    "Jalingo Town",
    "Kona",
    "Magami",
    "Mayo Gwoi",
    "Sabon Gari"
   ],
   "Karim Lamido": [
    "Karim Lamido Town",
    "Kodomun",
    "Sabon Layi"
   ],
   "Kurmi": [
    "Kurmi Town",
    "Lissam",
    "Mayo Selbe",
    "Sabon Gari Kurmi"
   ],
   "Lau": [
    "Lau Town",
    "Sabon Gari Lau"
   ],
   "Sardauna": [
    "Gembu",
    "Maisamari",
    "Mambilla Plateau",
    "Mayo Ndaga",
    "Nguroje"
   ],
   "Takum": [
    "Chanchanji",
    "Rafin Kada",
    "Takum Town",
    "Yangtu"
   ],
   "Ussa": [
    "Lissam",
    "Mayo Selbe",
    "Ussa Town"
   ],
   "Wukari": [
    "Akwana",
    "Chonku",
    "Puje",
    "Tsokundi",
    "Wukari Town"
   ],
   "Yorro": [
    "Pupule",
    "Sabon Layi",
    "Yorro Town"
   ],
   "Zing": [
    "Mayo Gwoi",
    "Zing Town"
   ]
  }
 },
 "Yobe": {
  "capital": "Damaturu",
  "cities": {
   "Bade": [
    "Bade Town",
    "Dachia",
    "Gashua",
    "Jawa",
    "Katuzu"
   ],
   "Bursari": [
    "Bursari Town",
    "Dapchi",
    "Jaji Maji",
    "Mutai"
   ],
   "Damaturu": [
    "Bindigari",
    "Damaturu Town",
    "Gonduwa",
    "Nayinawa",
    "Sabon Pegi"
   ],
   "Fika": [
    "Daya",
    "Fika Town",
    "Gadaka",
    "Kukar Gadu"
   ],
   "Fune": [
    "Damagum",
    "Dogon Kuka",
    "Fune Town",
    "Gadaka",
    "Mamudo"
   ],
   "Geidam": [
    "Dole",
    "Geidam Town",
    "Mallam Fatori"
   ],
   "Gujba": [
    "Buni Yadi",
    "Goniri",
    "Gujba Town",
    "Mutai"
   ],
   "Gulani": [
    "Bara",
    "Gotumba",
    "Gulani Town",
    "Hausari"
   ],
   "Jakusko": [
    "Bayamari",
    "Garin Gada",
    "Jakusko Town"
   ],
   "Karasuwa": [
    "Garin Kuka",
    "Karasuwa Town",
    "Kawuri"
   ],
   "Machina": [
    "Dagona",
    "Katarko",
    "Machina Town"
   ],
   "Nangere": [
    "Daya",
    "Gadaka",
    "Nangere Town"
   ],
   "Nguru": [
    "Dadigar",
    "Garin Hamza",
    "Magaram",
    "Nguru Town"
   ],
   "Potiskum": [
    "Bula",
    "Dogo Tuwo",
    "Kukar Gadu",
    "Mamudo",
    "Potiskum Town"
   ],
   "Tarmuwa": [
    "Kukareta",
    "Tarmuwa Town"
   ],
   "Yunusari": [
    "Yunusari Town"
   ],
   "Yusufari": [
    "Yusufari Town"
   ]
  }
 },
 "Zamfara": {
  "capital": "Gusau",
  "cities": {
   "Anka": [
    "Anka Town",
    "Jangeru",
    "Yar Gaji"
   ],
   "Bakura": [
    "Bakura Town",
    "Dankurmi"
   ],
   "Birnin Magaji/Kiyaw": [
    "Birnin Magaji",
    "Kiyaw"
   ],
   "Bukkuyum": [
    "Bukkuyum Town",
    "Dumburum",
    "Zugu"
   ],
   "Bungudu": [
    "Bungudu Town"
   ],
   "Gummi": [
    "Gummi Town"
   ],
   "Gusau": [
    "Gusau Town",
    "Mada",
    "Sabon Gari Gusau",
    "Samaru",
    "Tudun Wada"
   ],
   "Kaura Namoda": [
    "Kaura Namoda Town"
   ],
   "Maradun": [
    "Maradun Town"
   ],
   "Maru": [
    "Maru Town"
   ],
   "Shinkafi": [
    "Shinkafi Town"
   ],
   "Talata Mafara": [
    "Talata Mafara Town"
   ],
   "Tsafe": [
    "Tsafe Town"
   ],
   "Zurmi": [
    "Zurmi Town"
   ]
  }
 }
}

/** Every state name, in the order Nigeria lists them (FCT last-ish as given). */
function states() {
  return Object.keys(LOCATIONS);
}

/** State exists? Case-insensitive, ignores punctuation like "FCT - Abuja". */
function hasState(name) {
  const key = findState(name);
  return Boolean(key);
}

function findState(name) {
  return canonicalState(name);
}

/** Cities (LGAs / area councils) under a state, alphabetical. */
function cities(state) {
  const key = findState(state);
  if (!key) return [];
  return Object.keys(LOCATIONS[key].cities)
    .map(canonicalCityName)
    .sort((a, b) => a.localeCompare(b));
}

/** Towns under a city of a state, alphabetical. */
function towns(state, city) {
  const key = findState(state);
  if (!key) return [];
  const cityKey = Object.keys(LOCATIONS[key].cities).find((c) => normalise(c) === normalise(city));
  if (!cityKey) return [];
  return LOCATIONS[key].cities[cityKey].slice().sort((a, b) => a.localeCompare(b));
}

/** Every accepted spelling of one city of a state, or [] when unknown. The
    dataset's own name comes first; an alias (see CITY_ALIASES) is added so a
    record stored under either spelling is found by the same filter. */
function citySpellings(state, value) {
  const key = findState(state);
  if (!key) return [];
  const cityKey = Object.keys(LOCATIONS[key].cities).find((c) => normalise(c) === normalise(value));
  if (!cityKey) return [];
  const out = [canonicalCityName(cityKey)];
  if (!out.includes(cityKey)) out.push(cityKey);
  return out;
}

/* Spellings the older free-text forms and the platform's own state select
   have stored over the years ("FCT - Abuja", "Nassarawa"). They resolve to the
   dataset's own name so a filter never silently misses a tenant. */
const STATE_ALIASES = {
  "fct abuja": "Federal Capital Territory",
  fct: "Federal Capital Territory",
  abuja: "Federal Capital Territory",
  nassarawa: "Nasarawa",
  "akwa ibom state": "Akwa Ibom",
};

/* Cities the dataset spells one way while the rest of the platform spells
   another: "Ijebu Ode" is the LGA's official name, the city itself is written
   "Ijebu-Ode" everywhere else (including in the platform's own records). The
   alias is what the forms and the directory offer; both spellings are accepted
   when filtering. */
const CITY_ALIASES = {
  "ijebu ode": "Ijebu-Ode",
};

function canonicalCityName(name) {
  return CITY_ALIASES[normalise(name)] || name;
}

function normalise(value) {
  return String(value == null ? "" : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The dataset's own state name for any accepted spelling, or null. */
function canonicalState(value) {
  const key = normalise(value);
  if (!key) return null;
  if (STATE_ALIASES[key]) return STATE_ALIASES[key];
  return Object.keys(LOCATIONS).find((s) => normalise(s) === key) || null;
}

module.exports = { LOCATIONS, states, cities, towns, citySpellings, canonicalCityName, hasState, findState, canonicalState };
