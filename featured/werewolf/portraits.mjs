function portrait(id, post, author, position, zoom) {
  return {
    image: './portraits/' + id + '.webp',
    source: 'https://www.hoyolab.com/article/' + post,
    author, position, zoom,
  };
}

// Artwork by the linked creators, who permit reposting or use with credit.
export const PORTRAITS = Object.freeze({
  lumine: portrait('lumine', '30205094', 'RiaAkiduki/秋月リア', '50% 10%'),
  furina: portrait('furina', '30738797', 'Azzy_chu', '50% 44%'),
  hutao: portrait('hutao', '764794', 'Laurella'),
  firefly: portrait('firefly', '25886701', 'Akanichiyu', '50% 10%'),
  elysia: portrait('elysia', '4927093', 'ramkookie', '50% 0%', 1.18),
  zhongli: portrait('zhongli', '764794', 'Laurella'),
  raiden: portrait('raiden', '3107858', 'HachigatsuArt'),
  kafka: portrait('kafka', '21210019', 'Maybisu', '55% 0%', 1.44),
  silverwolf: portrait('silverwolf', '21562005', 'epimedium', '51% 0%', 1.35),
  sandrone: portrait('sandrone', '39850071', 'Dendroe', '48% 42%', 1.15),
  columbina: portrait('columbina', '41595309', 'Koase', '50% 0%', 1.66),
  venti: portrait('venti', '28029712', 'K3N0KAY'),
});
