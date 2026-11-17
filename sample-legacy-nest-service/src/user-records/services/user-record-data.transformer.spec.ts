import { UserRecordDataTransformer } from './user-record-data.transformer';

describe('UserRecordDataTransformer', () => {
  const transformer = new UserRecordDataTransformer();

  it('trims, upper-cases countries and formats dates', () => {
    expect(transformer.normalize({ firstName: ' Ana ', countryOfBirth: 'prt', dateOfBirth: '1990-04-03T00:00:00Z', middleName: '' })).toEqual({
      firstName: 'Ana',
      countryOfBirth: 'PRT',
      dateOfBirth: '1990-04-03',
    });
  });
});
