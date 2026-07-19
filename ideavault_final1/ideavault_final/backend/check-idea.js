const mongoose = require('mongoose');

async function run() {
  await mongoose.connect('mongodb://127.0.0.1:27017/ideavault', { useNewUrlParser: true });
  const db = mongoose.connection;
  const Idea = mongoose.model('Idea', new mongoose.Schema({}, { strict: false }));
  
  const idea = await Idea.findById('6a04201bdd8273cd73a5edbd').lean();
  console.log(JSON.stringify(idea, null, 2));
  process.exit(0);
}

run();
