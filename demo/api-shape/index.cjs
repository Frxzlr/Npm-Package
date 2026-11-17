// The API used to return an array. Now it returns { results: [...] }.
async function getUsers() {
  return { results: [{ name: 'Ada' }, { name: 'Linus' }] };
}

async function main() {
  const response = await getUsers();
  const names = response.users.map((user) => user.name);
  console.log(names);
}

main();
