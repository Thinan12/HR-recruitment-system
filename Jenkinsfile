// Runs the LALCO HR Postman collection (the one in this repository, see
// postman/README.md) with the Postman CLI.
//
// Jenkins setup: Manage Jenkins -> Credentials, two "Secret text" credentials:
//   postman-api-key       a Postman API key (a NEW one; never paste a key in this file)
//   lalco-admin-password  the HR admin password of the environment you run against
// No secret is written in this file, in the collection or in the committed
// environments. Jenkins masks both values in the console log.
pipeline {
  agent any

  parameters {
    choice(name: 'TARGET', choices: ['Production', 'Local'], description: 'Which committed Postman environment to run against')
  }

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
        // Single quotes: the shell reads the variable, so Groovy never puts the key in the command line log.
        sh 'postman login --with-api-key "$POSTMAN_API_KEY"'
      }
    }

    stage('Running collection') {
      steps {
        // --working-dir: the upload requests attach files from postman/fixtures.
        // adminPassword is never stored in an environment file: it comes from the credential.
        sh '''
          postman collection run postman/LALCO-HR-Recruitment-System.postman_collection.json \
            -e "postman/env/LALCO-HR-${TARGET}.postman_environment.json" \
            --working-dir postman \
            --env-var "adminPassword=$LALCO_ADMIN_PASSWORD"
        '''
      }
    }
  }

  post {
    always {
      sh 'postman logout || true'
    }
  }
}
