// Runs the LALCO HR Postman collection (see postman/README.md) with the Postman CLI.
// Jenkins setup:
//   - Global Tool Configuration → NodeJS: replace {your_nodejs_configured_tool_name} below with its name.
//   - Credentials (Secret text): "postman-api-key" (your Postman API key) and
//     "lalco-admin-password" (the admin password of the environment you run against).
pipeline {
  agent any

  tools {nodejs "{your_nodejs_configured_tool_name}"}

  environment {
    POSTMAN_API_KEY = credentials('postman-api-key')
    LALCO_ADMIN_PASSWORD = credentials('lalco-admin-password')
  }

  stages {
    stage('Install Postman CLI') {
      steps {
        sh 'curl -o- "https://dl-cli.pstmn.io/install/linux64.sh" | sh'
      }
    }

    stage('Postman CLI Login') {
      steps {
        sh 'postman login --with-api-key $POSTMAN_API_KEY'
        }
    }

    stage('Running collection') {
      steps {
        // --working-dir: the upload requests attach files from postman/fixtures in this repository.
        // adminPassword is not stored in the Postman environment, so it is passed here.
        sh 'postman collection run "DE780da9fAA50fcAaCCCbFFD" -e "b862e886-4112-4d9a-88d0-bb9fc6553800" --working-dir postman --env-var "adminPassword=$LALCO_ADMIN_PASSWORD"'
      }
    }
  }
}
